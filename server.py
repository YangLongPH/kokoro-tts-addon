#!/usr/bin/env python3
"""
Vietnamese TTS Server using capleaf/viXTTS (XTTS-v2 fine-tune)
"""
import io
import re
import logging
import numpy as np
from pathlib import Path
import torch
import soundfile as sf
from flask import Flask, request, jsonify, send_file, Response
from flask_cors import CORS

app = Flask(__name__)
CORS(app)
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

MODEL_ID = "capleaf/viXTTS"
SPEAKER_WAV = Path(__file__).parent / "reference_speaker.wav"
SAMPLE_RATE = 24000

tts_model = None
tts_config = None
_speaker_latents = None

VOICES = {
    'vi_default': 'Vietnamese (Default)',
}

def split_text(text, max_chars=220):
    """Split text into chunks under max_chars, respecting sentence boundaries."""
    sentences = re.split(r'(?<=[.!?;,])\s+|\n+', text)
    chunks = []
    current = ""
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(current) + len(sentence) + 1 <= max_chars:
            current = (current + " " + sentence).strip()
        else:
            if current:
                chunks.append(current)
            if len(sentence) > max_chars:
                # Force-split sentence by words
                words = sentence.split()
                current = ""
                for word in words:
                    if len(current) + len(word) + 1 <= max_chars:
                        current = (current + " " + word).strip()
                    else:
                        if current:
                            chunks.append(current)
                        current = word
            else:
                current = sentence
    if current:
        chunks.append(current)
    return chunks

LANGUAGES = {
    'vi': '🇻🇳 Vietnamese',
    'en': '🇺🇸 English',
    'fr': '🇫🇷 French',
    'es': '🇪🇸 Spanish',
    'de': '🇩🇪 German',
    'it': '🇮🇹 Italian',
    'pt': '🇧🇷 Portuguese',
    'zh-cn': '🇨🇳 Chinese',
    'ja': '🇯🇵 Japanese',
    'ko': '🇰🇷 Korean',
    'hi': '🇮🇳 Hindi',
}


def ensure_reference_audio():
    """Return path to reference speaker audio, generating one via edge-tts if missing."""
    if SPEAKER_WAV.exists():
        return str(SPEAKER_WAV)

    app.logger.info("reference_speaker.wav not found — generating with edge-tts...")
    try:
        import asyncio
        import edge_tts

        async def _gen():
            comm = edge_tts.Communicate(
                "Xin chào, đây là giọng nói mẫu để tổng hợp tiếng nói.",
                "vi-VN-HoaiMyNeural"
            )
            await comm.save(str(SPEAKER_WAV))

        asyncio.run(_gen())
        app.logger.info(f"Reference audio saved to {SPEAKER_WAV}")
        return str(SPEAKER_WAV)
    except Exception as e:
        raise RuntimeError(
            f"Could not generate reference audio ({e}). "
            f"Place a Vietnamese WAV file (3-10 s) at: {SPEAKER_WAV}"
        )


def load_model():
    global tts_model, tts_config, _speaker_latents

    from huggingface_hub import snapshot_download
    from TTS.tts.configs.xtts_config import XttsConfig
    from TTS.tts.models.xtts import Xtts
    import TTS.tts.models.xtts as _xtts_mod

    # Patch audio loader to use soundfile instead of torchaudio/TorchCodec
    def _sf_load_audio(file_path, sample_rate):
        data, sr = sf.read(str(file_path), dtype='float32')
        if data.ndim > 1:
            data = data.mean(axis=1)
        if sr != sample_rate:
            from scipy.signal import resample
            data = resample(data, int(round(len(data) * sample_rate / sr)))
        return torch.from_numpy(data).unsqueeze(0)

    _xtts_mod.load_audio = _sf_load_audio
    app.logger.info("Audio loader patched (soundfile backend)")

    # Patch tokenizer to support Vietnamese ('vi' not in base XTTS language list)
    from TTS.tts.layers.xtts.tokenizer import VoiceBpeTokenizer
    _orig_preprocess = VoiceBpeTokenizer.preprocess_text

    def _preprocess_with_vi(self, txt, lang):
        if lang == 'vi':
            return txt.strip()
        return _orig_preprocess(self, txt, lang)

    VoiceBpeTokenizer.preprocess_text = _preprocess_with_vi
    app.logger.info("Tokenizer patched for Vietnamese")

    app.logger.info(f"Downloading {MODEL_ID} (first run only)…")
    model_path = snapshot_download(MODEL_ID)
    app.logger.info(f"Model path: {model_path}")

    config = XttsConfig()
    config.load_json(str(Path(model_path) / "config.json"))

    model = Xtts.init_from_config(config)
    model.load_checkpoint(config, checkpoint_dir=model_path, eval=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)
    app.logger.info(f"Model loaded on {device}")

    tts_model = model
    tts_config = config

    speaker_wav = ensure_reference_audio()
    app.logger.info(f"Computing speaker embedding from: {speaker_wav}")
    _speaker_latents = model.get_conditioning_latents(
        audio_path=[speaker_wav],
        gpt_cond_len=config.gpt_cond_len,
        max_ref_length=config.max_ref_len,
        sound_norm_refs=config.sound_norm_refs,
    )
    app.logger.info("Speaker embedding cached.")


def get_model():
    if tts_model is None:
        load_model()
    return tts_model, tts_config


def get_latents():
    if _speaker_latents is None:
        get_model()
    return _speaker_latents


@app.route('/health', methods=['GET'])
def health_check():
    try:
        return jsonify({
            'status': 'healthy',
            'message': 'viXTTS server is running',
            'model': MODEL_ID,
            'device': 'cuda' if torch.cuda.is_available() else 'cpu',
            'available_voices': list(VOICES.keys()),
            'available_languages': list(LANGUAGES.keys()),
        }), 200
    except Exception as e:
        return jsonify({'status': 'unhealthy', 'message': str(e)}), 503


@app.route('/generate', methods=['POST'])
def generate_speech():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'No JSON data provided'}), 400

        text = data.get('text', '').strip()
        language = data.get('language', 'vi')
        speed = float(data.get('speed', 1.0))

        if not text:
            return jsonify({'error': 'No text provided'}), 400
        if language not in LANGUAGES:
            language = 'vi'

        model, config = get_model()
        gpt_cond_latent, speaker_embedding = get_latents()

        chunks = split_text(text)
        app.logger.info(f"Generating [{language}] in {len(chunks)} chunk(s): {text[:60]}")

        all_wav = []
        for chunk in chunks:
            output = model.inference(
                text=chunk,
                language=language,
                gpt_cond_latent=gpt_cond_latent,
                speaker_embedding=speaker_embedding,
                temperature=0.7,
                length_penalty=1.0,
                repetition_penalty=10.0,
                top_k=50,
                top_p=0.85,
                speed=speed,
            )
            all_wav.append(np.array(output["wav"], dtype=np.float32))

        wav = np.concatenate(all_wav) if len(all_wav) > 1 else all_wav[0]
        buf = io.BytesIO()
        sf.write(buf, wav, SAMPLE_RATE, format='wav')
        buf.seek(0)
        return send_file(buf, mimetype='audio/wav', as_attachment=False, download_name='speech.wav')

    except Exception as e:
        app.logger.exception(f"Generation error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/stream', methods=['POST'])
def stream_speech():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'No JSON data provided'}), 400

        text = data.get('text', '').strip()
        language = data.get('language', 'vi')
        speed = float(data.get('speed', 1.0))

        if not text:
            return jsonify({'error': 'No text provided'}), 400
        if language not in LANGUAGES:
            language = 'vi'

        model, config = get_model()
        gpt_cond_latent, speaker_embedding = get_latents()

        text_chunks = split_text(text)
        app.logger.info(f"Streaming [{language}] in {len(text_chunks)} chunk(s)")

        MIN_CHUNK_BYTES = int(SAMPLE_RATE * 0.15 * 2)  # 150ms buffer per send

        def generate():
            buf = b""
            for text_chunk in text_chunks:
                try:
                    for audio_chunk in model.inference_stream(
                        text=text_chunk,
                        language=language,
                        gpt_cond_latent=gpt_cond_latent,
                        speaker_embedding=speaker_embedding,
                        temperature=0.7,
                        speed=speed,
                    ):
                        if isinstance(audio_chunk, torch.Tensor):
                            audio_chunk = audio_chunk.cpu().numpy()
                        buf += (audio_chunk * 32767).astype(np.int16).tobytes()
                        while len(buf) >= MIN_CHUNK_BYTES:
                            yield buf[:MIN_CHUNK_BYTES]
                            buf = buf[MIN_CHUNK_BYTES:]
                except Exception as e:
                    app.logger.error(f"Stream error on chunk '{text_chunk[:40]}': {e}")
            if buf:
                yield buf

        return Response(generate(), mimetype='audio/x-raw')

    except Exception as e:
        app.logger.exception(f"Stream setup error: {e}")
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    app.logger.info("Loading model at startup…")
    try:
        get_model()
        app.logger.info("Server ready!")
    except Exception as e:
        app.logger.error(f"Model load failed: {e}")

    # threaded=False because XTTS/CUDA is not thread-safe
    app.run(host='0.0.0.0', port=8000, debug=False, threaded=False)
