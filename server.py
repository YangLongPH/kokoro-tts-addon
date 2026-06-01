#!/usr/bin/env python3
"""
Kokoro TTS Server
Switch models by changing ACTIVE_BACKEND below.
"""
import io
import re
import logging
import numpy as np
import soundfile as sf
from pathlib import Path
from flask import Flask, request, jsonify, send_file, Response
from flask_cors import CORS

app = Flask(__name__)
CORS(app)
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')

# ─── Config ───────────────────────────────────────────────────────────────────
DEFAULT_MODEL = 'piper'   # used when no model is specified in the request
# ──────────────────────────────────────────────────────────────────────────────


# ─── Backend Abstraction ──────────────────────────────────────────────────────

ALL_LANGUAGE_LABELS = {
    'vi': '🇻🇳 Vietnamese', 'en': '🇺🇸 English', 'fr': '🇫🇷 French',
    'es': '🇪🇸 Spanish',   'de': '🇩🇪 German',  'it': '🇮🇹 Italian',
    'pt': '🇧🇷 Portuguese', 'zh-cn': '🇨🇳 Chinese', 'ja': '🇯🇵 Japanese',
    'ko': '🇰🇷 Korean',    'hi': '🇮🇳 Hindi',
}


class TTSBackend:
    name = 'base'
    sample_rate = 16000
    voices = ['vi_default']
    voice_labels = {}     # code → display name
    languages = ['vi']

    def load(self):
        raise NotImplementedError

    def synthesize(self, text: str, voice: str = None, speed: float = 1.0, language: str = 'vi') -> np.ndarray:
        """Return float32 numpy array at self.sample_rate."""
        raise NotImplementedError

    def language_labels(self):
        return {k: ALL_LANGUAGE_LABELS[k] for k in self.languages if k in ALL_LANGUAGE_LABELS}


class VietTTSBackend(TTSBackend):
    """VietTTS by NTT123 — pip install git+https://github.com/NTT123/vietTTS.git jax jaxlib"""
    name = 'VietTTS'
    sample_rate = 16000
    voices = ['vi_female']
    languages = ['vi']

    def load(self):
        import re, unicodedata
        from vietTTS.nat.text2mel import text2mel
        from vietTTS.hifigan.mel2wave import mel2wave
        from vietTTS.nat.config import FLAGS
        self._text2mel = text2mel
        self._mel2wave = mel2wave
        self._FLAGS = FLAGS
        self._re = re
        self._unicodedata = unicodedata
        app.logger.info("VietTTS loaded (model weights download on first synthesize call).")

    def _normalize(self, text):
        re, ud, FLAGS = self._re, self._unicodedata, self._FLAGS
        text = ud.normalize("NFKC", text).lower().strip()
        sil = FLAGS.special_phonemes[FLAGS.sil_index]
        text = re.sub(r"[\n.,:]+", f" {sil} ", text)
        text = text.replace('"', " ")
        text = re.sub(r"\s+", " ", text)
        text = re.sub(r"[.,:;?!]+", f" {sil} ", text)
        text = re.sub("[ ]+", " ", text)
        text = re.sub(f"( {sil}+)+ ", f" {sil} ", text)
        return text.strip()

    def synthesize(self, text, voice=None, speed=1.0, language='vi'):
        text = self._normalize(text)
        mel = self._text2mel(text, None, -1)
        wave = self._mel2wave(mel)
        return np.array(wave, dtype=np.float32)


class ViXTTSBackend(TTSBackend):
    """capleaf/viXTTS — pip install TTS huggingface_hub transformers==4.40.2 torch soundfile scipy edge-tts"""
    name = 'viXTTS'
    sample_rate = 24000
    voices = ['vi_default']
    voice_labels = {'vi_default': 'Vietnamese (viXTTS)'}
    languages = ['vi', 'en', 'fr', 'es', 'de', 'it', 'pt', 'zh-cn', 'ja', 'ko', 'hi']

    def load(self):
        import torch
        from pathlib import Path
        from huggingface_hub import snapshot_download
        from TTS.tts.configs.xtts_config import XttsConfig
        from TTS.tts.models.xtts import Xtts
        import TTS.tts.models.xtts as _xtts_mod

        # Patch: use soundfile instead of TorchCodec
        def _sf_load(file_path, sample_rate):
            data, sr = sf.read(str(file_path), dtype='float32')
            if data.ndim > 1: data = data.mean(axis=1)
            if sr != sample_rate:
                from scipy.signal import resample
                data = resample(data, int(round(len(data) * sample_rate / sr)))
            return torch.from_numpy(data).unsqueeze(0)
        _xtts_mod.load_audio = _sf_load

        # Patch: Vietnamese tokenizer support
        from TTS.tts.layers.xtts.tokenizer import VoiceBpeTokenizer
        _orig = VoiceBpeTokenizer.preprocess_text
        def _preprocess(self, txt, lang):
            return txt.strip() if lang == 'vi' else _orig(self, txt, lang)
        VoiceBpeTokenizer.preprocess_text = _preprocess

        model_path = snapshot_download("capleaf/viXTTS")
        config = XttsConfig()
        config.load_json(str(Path(model_path) / "config.json"))
        model = Xtts.init_from_config(config)
        model.load_checkpoint(config, checkpoint_dir=model_path, eval=True)
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model.to(device)

        speaker_wav = self._ensure_reference_wav()
        self._latents = model.get_conditioning_latents(
            audio_path=[speaker_wav],
            gpt_cond_len=config.gpt_cond_len,
            max_ref_length=config.max_ref_len,
            sound_norm_refs=config.sound_norm_refs,
        )
        self._model = model
        self._config = config
        app.logger.info(f"viXTTS loaded on {device}.")

    def _ensure_reference_wav(self):
        from pathlib import Path
        wav = Path(__file__).parent / "reference_speaker.wav"
        if not wav.exists():
            import asyncio, edge_tts
            async def _gen():
                await edge_tts.Communicate(
                    "Xin chào, đây là giọng nói mẫu.", "vi-VN-HoaiMyNeural"
                ).save(str(wav))
            asyncio.run(_gen())
        return str(wav)

    def synthesize(self, text, voice=None, speed=1.0, language='vi'):
        gpt_cond_latent, speaker_embedding = self._latents
        out = self._model.inference(
            text=text, language=language,
            gpt_cond_latent=gpt_cond_latent,
            speaker_embedding=speaker_embedding,
            temperature=0.7, length_penalty=1.0,
            repetition_penalty=10.0, top_k=50, top_p=0.85, speed=speed,
        )
        return np.array(out["wav"], dtype=np.float32)


class EdgeTTSBackend(TTSBackend):
    """Microsoft Edge TTS — pip install edge-tts (requires internet)"""
    name = 'edge_tts'
    sample_rate = 24000
    voices = ['vi-VN-HoaiMyNeural', 'vi-VN-NamMinhNeural']
    languages = ['vi']

    def load(self):
        import edge_tts  # noqa — verify installed
        app.logger.info("EdgeTTS backend ready (requires internet).")

    def synthesize(self, text, voice='vi-VN-HoaiMyNeural', speed=1.0, language='vi'):
        import asyncio, subprocess, tempfile, os, edge_tts
        voice = voice if voice in self.voices else self.voices[0]
        rate = f"{int((speed - 1) * 100):+d}%"

        tmp_mp3 = tempfile.mktemp(suffix='.mp3')
        tmp_wav = tempfile.mktemp(suffix='.wav')
        try:
            async def _gen():
                await edge_tts.Communicate(text, voice, rate=rate).save(tmp_mp3)
            asyncio.run(_gen())

            # Convert MP3 → WAV using macOS afconvert (no ffmpeg needed)
            subprocess.run([
                'afconvert', '-f', 'WAVE', '-d', f'LEI16@{self.sample_rate}',
                '-c', '1', tmp_mp3, tmp_wav
            ], check=True, capture_output=True)

            data, _ = sf.read(tmp_wav, dtype='float32')
            if data.ndim > 1:
                data = data.mean(axis=1)
            return data
        finally:
            for p in (tmp_mp3, tmp_wav):
                try: os.unlink(p)
                except FileNotFoundError: pass


class LightSpeedBackend(TTSBackend):
    """ntt123/Vietnam-female-voice-TTS — LightSpeed VITS, offline, 16 kHz
    Weights auto-downloaded from HuggingFace on first run (~200 MB).
    """
    name = 'LightSpeed'
    sample_rate = 16000
    voices = ['vi_female']
    voice_labels = {'vi_female': 'Vietnamese Female (LightSpeed)'}
    languages = ['vi']

    _MODEL_DIR = Path(__file__).parent / 'lightspeed'
    _HF_BASE = 'https://huggingface.co/spaces/ntt123/Vietnam-female-voice-TTS/resolve/main/'

    def load(self):
        import sys, json, torch
        from types import SimpleNamespace
        from pathlib import Path

        model_dir = str(self._MODEL_DIR)
        if model_dir not in sys.path:
            sys.path.insert(0, model_dir)

        self._download_weights()

        with open(self._MODEL_DIR / 'config.json', 'rb') as f:
            hps = json.load(f, object_hook=lambda x: SimpleNamespace(**x))
        self._hps = hps

        with open(self._MODEL_DIR / 'phone_set.json') as f:
            phone_set = json.load(f)
        self._phone_set = phone_set
        self._sil_idx = phone_set.index('sil')

        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        self._device = device

        from models import DurationNet, SynthesizerTrn

        duration_net = DurationNet(hps.data.vocab_size, 64, 4).to(device)
        duration_net.load_state_dict(torch.load(
            str(self._MODEL_DIR / 'duration_model.pth'), map_location=device, weights_only=True))
        duration_net.eval()

        generator = SynthesizerTrn(
            hps.data.vocab_size,
            hps.data.filter_length // 2 + 1,
            hps.train.segment_size // hps.data.hop_length,
            **vars(hps.model),
        ).to(device)
        del generator.enc_q
        ckpt = torch.load(str(self._MODEL_DIR / 'gen_630k.pth'), map_location=device, weights_only=True)
        params = {(k[7:] if k.startswith('module.') else k): v for k, v in ckpt['net_g'].items()}
        generator.load_state_dict(params, strict=False)
        del ckpt, params
        generator.eval()

        self._duration_net = duration_net
        self._generator = generator
        app.logger.info(f"LightSpeed loaded on {device}.")

    def _download_weights(self):
        import urllib.request
        for fname in ['duration_model.pth', 'gen_630k.pth']:
            target = self._MODEL_DIR / fname
            if not target.exists():
                app.logger.info(f"Downloading {fname} from HuggingFace…")
                urllib.request.urlretrieve(self._HF_BASE + fname, str(target))
                app.logger.info(f"Saved {fname}.")

    def _text_to_phone_idx(self, text):
        import re, unicodedata, regex as _regex

        phone_set = self._phone_set
        sil_idx = self._sil_idx
        num_re = _regex.compile(r"([0-9.,]*[0-9])")
        digits = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"]

        def read_number(num):
            if len(num) == 1:
                return digits[int(num)]
            elif len(num) == 2 and num.isdigit():
                n = int(num)
                end = digits[n % 10]
                if n == 10: return "mười"
                if n % 10 == 5: end = "lăm"
                if n % 10 == 0: return digits[n // 10] + " mươi"
                elif n < 20: return "mười " + end
                else:
                    if n % 10 == 1: end = "mốt"
                    return digits[n // 10] + " mươi " + end
            elif len(num) == 3 and num.isdigit():
                n = int(num)
                if n % 100 == 0: return digits[n // 100] + " trăm"
                elif num[1] == "0": return digits[n // 100] + " trăm lẻ " + digits[n % 100]
                else: return digits[n // 100] + " trăm " + read_number(num[1:])
            elif "," in num:
                n1, n2 = num.split(",")
                return read_number(n1) + " phẩy " + read_number(n2)
            elif "." in num:
                parts = num.split(".")
                if len(parts) == 2:
                    if parts[1] == "000": return read_number(parts[0]) + " ngàn"
                    elif parts[1].startswith("00"): return read_number(parts[0]) + " ngàn lẻ " + digits[int(parts[1][2:])]
                    else: return read_number(parts[0]) + " ngàn " + read_number(parts[1])
                elif len(parts) == 3:
                    return read_number(parts[0]) + " triệu " + read_number(parts[1]) + " ngàn " + read_number(parts[2])
            return num

        text = text.lower()
        text = unicodedata.normalize("NFKC", text)
        for ch, rep in [(".", " . "), (",", " , "), (";", " ; "), (":", " : "), ("!", " ! "), ("?", " ? "), ("(", " ( ")]:
            text = text.replace(ch, rep)
        text = num_re.sub(r" \1 ", text)
        words = text.split()
        words = [read_number(w) if num_re.fullmatch(w) else w for w in words]
        text = re.sub(r"\s+", " ", " ".join(words)).strip()

        tokens = []
        for c in text:
            if c in ":,.!?;(": tokens.append(sil_idx)
            elif c in phone_set: tokens.append(phone_set.index(c))
            elif c == " ": tokens.append(0)
        if not tokens: return [sil_idx, 0, sil_idx]
        if tokens[0] != sil_idx: tokens = [sil_idx, 0] + tokens
        if tokens[-1] != sil_idx: tokens = tokens + [0, sil_idx]
        return tokens

    def synthesize(self, text, voice=None, speed=1.0, language='vi'):
        import torch

        if len(text) > 500:
            text = text[:500]

        phone_idx = self._text_to_phone_idx(text)
        hps = self._hps
        device = self._device

        phone_length = torch.tensor([len(phone_idx)], dtype=torch.long).to(device)
        phone_idx_t = torch.tensor([phone_idx], dtype=torch.long).to(device)

        with torch.inference_mode():
            phone_duration = self._duration_net(phone_idx_t, phone_length)[:, :, 0] * 1000

        phone_duration = torch.where(
            phone_idx_t == self._sil_idx, torch.clamp_min(phone_duration, 200), phone_duration)
        phone_duration = torch.where(phone_idx_t == 0, torch.zeros_like(phone_duration), phone_duration)

        end_time = torch.cumsum(phone_duration, dim=-1)
        start_time = end_time - phone_duration
        sr, hop = hps.data.sampling_rate, hps.data.hop_length
        start_frame = start_time / 1000 * sr / hop
        end_frame   = end_time   / 1000 * sr / hop
        spec_length = end_frame.max(dim=-1).values
        pos = torch.arange(0, spec_length.item(), device=device)
        attn = torch.logical_and(
            pos[None, :, None] >= start_frame[:, None, :],
            pos[None, :, None] <  end_frame[:, None, :],
        ).float()

        with torch.inference_mode():
            y_hat = self._generator.infer(
                phone_idx_t, phone_length, spec_length, attn,
                max_len=None, noise_scale=0.0
            )[0]

        return y_hat[0, 0].data.cpu().numpy().astype(np.float32)


class PiperBackend(TTSBackend):
    """Piper TTS — Vietnamese female voice (VIVOS dataset), offline, ONNX
    pip install piper-tts
    Model auto-downloaded from HuggingFace on first run (~60 MB).
    """
    name = 'Piper'
    sample_rate = 22050  # updated from model config after load
    voices = ['vi_VN-vais1000-medium']
    voice_labels = {'vi_VN-vais1000-medium': 'Vietnamese Female (Piper VAIS1000)'}
    languages = ['vi']

    _MODEL_DIR = Path(__file__).parent / 'piper_models'
    _VOICE = 'vi_VN-vais1000-medium'
    _HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/vi/vi_VN/vais1000/medium/'

    def load(self):
        import urllib.request
        self._MODEL_DIR.mkdir(exist_ok=True)

        for fname in [f'{self._VOICE}.onnx', f'{self._VOICE}.onnx.json']:
            target = self._MODEL_DIR / fname
            if not target.exists():
                app.logger.info(f"Downloading {fname}…")
                urllib.request.urlretrieve(self._HF_BASE + fname, str(target))

        from piper.voice import PiperVoice
        self._voice = PiperVoice.load(
            str(self._MODEL_DIR / f'{self._VOICE}.onnx'),
            config_path=str(self._MODEL_DIR / f'{self._VOICE}.onnx.json'),
            use_cuda=False,
        )
        self.sample_rate = self._voice.config.sample_rate
        app.logger.info(f"Piper loaded. sample_rate={self.sample_rate}")

    def synthesize(self, text, voice=None, speed=1.0, language='vi'):
        from piper.config import SynthesisConfig

        length_scale = 1.0 / speed if speed and speed != 1.0 else 1.0
        syn_config = SynthesisConfig(length_scale=length_scale)
        chunks = [chunk.audio_float_array for chunk in self._voice.synthesize(text, syn_config)]
        if not chunks:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(chunks).astype(np.float32)


class KokoroBackend(TTSBackend):
    """hexgrad/Kokoro-82M — pip install kokoro torch soundfile
    Model auto-downloaded from HuggingFace on first run (~330 MB).
    28 English voices (American + British). Other languages share the same voices
    but use language-specific phonemisers.
    """
    name = 'Kokoro'
    sample_rate = 22050
    voices = [
        'af_heart', 'af_bella', 'af_sarah', 'af_sky', 'af_nicole',
        'af_alloy', 'af_aoede', 'af_jessica', 'af_kore', 'af_nova', 'af_river',
        'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
        'am_michael', 'am_onyx', 'am_puck', 'am_santa',
        'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
        'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
    ]
    voice_labels = {
        'af_heart': '🇺🇸 Heart (F)',    'af_bella': '🇺🇸 Bella (F)',
        'af_sarah': '🇺🇸 Sarah (F)',    'af_sky': '🇺🇸 Sky (F)',
        'af_nicole': '🇺🇸 Nicole (F)',  'af_alloy': '🇺🇸 Alloy (F)',
        'af_aoede': '🇺🇸 Aoede (F)',    'af_jessica': '🇺🇸 Jessica (F)',
        'af_kore': '🇺🇸 Kore (F)',      'af_nova': '🇺🇸 Nova (F)',
        'af_river': '🇺🇸 River (F)',
        'am_adam': '🇺🇸 Adam (M)',      'am_echo': '🇺🇸 Echo (M)',
        'am_eric': '🇺🇸 Eric (M)',      'am_fenrir': '🇺🇸 Fenrir (M)',
        'am_liam': '🇺🇸 Liam (M)',      'am_michael': '🇺🇸 Michael (M)',
        'am_onyx': '🇺🇸 Onyx (M)',      'am_puck': '🇺🇸 Puck (M)',
        'am_santa': '🇺🇸 Santa (M)',
        'bf_alice': '🇬🇧 Alice (F)',    'bf_emma': '🇬🇧 Emma (F)',
        'bf_isabella': '🇬🇧 Isabella (F)', 'bf_lily': '🇬🇧 Lily (F)',
        'bm_daniel': '🇬🇧 Daniel (M)', 'bm_fable': '🇬🇧 Fable (M)',
        'bm_george': '🇬🇧 George (M)', 'bm_lewis': '🇬🇧 Lewis (M)',
    }
    languages = ['en', 'fr', 'es', 'pt', 'hi', 'it', 'ja', 'zh-cn']

    # Maps our ISO language codes to Kokoro's single-letter lang_code
    _LANG_CODE = {
        'en': 'a', 'fr': 'f', 'es': 'e', 'pt': 'p',
        'hi': 'h', 'it': 'i', 'ja': 'j', 'zh-cn': 'z',
    }

    def load(self):
        from kokoro import KPipeline
        self._KPipeline = KPipeline
        self._pipelines = {}
        self._get_pipeline('a')   # pre-load American English
        app.logger.info("Kokoro-82M loaded (American English pipeline ready).")

    def _get_pipeline(self, lang_code):
        if lang_code not in self._pipelines:
            app.logger.info(f"Initializing Kokoro pipeline lang_code={lang_code}…")
            self._pipelines[lang_code] = self._KPipeline(lang_code=lang_code)
        return self._pipelines[lang_code]

    def synthesize(self, text, voice='af_heart', speed=1.0, language='en'):
        import torch

        voice = voice or 'af_heart'
        # British voices (bf_*, bm_*) need lang_code 'b' regardless of language setting
        if voice.startswith('bf_') or voice.startswith('bm_'):
            lang_code = 'b'
        else:
            lang_code = self._LANG_CODE.get(language, 'a')

        pipeline = self._get_pipeline(lang_code)
        segments = []
        with torch.no_grad():
            for _, _, audio in pipeline(text, voice=voice, speed=speed, split_pattern=r'\n+'):
                arr = audio.cpu().numpy() if hasattr(audio, 'cpu') else np.asarray(audio)
                segments.append(arr.astype(np.float32))

        return np.concatenate(segments) if segments else np.zeros(0, dtype=np.float32)


class MMSTTSBackend(TTSBackend):
    """Meta MMS-TTS Vietnamese — facebook/mms-tts-vie
    pip install transformers torch
    Model auto-downloaded from HuggingFace (~500 MB).
    """
    name = 'MMS-TTS'
    sample_rate = 16000
    voices = ['vi_female']
    voice_labels = {'vi_female': 'Vietnamese Female (MMS-TTS)'}
    languages = ['vi']

    def load(self):
        from transformers import VitsModel, AutoTokenizer
        import torch

        app.logger.info("Loading facebook/mms-tts-vie (first run downloads ~500 MB)…")
        self._tokenizer = AutoTokenizer.from_pretrained("facebook/mms-tts-vie")
        self._model = VitsModel.from_pretrained("facebook/mms-tts-vie")
        self._model.eval()
        self._device = 'cuda' if torch.cuda.is_available() else 'cpu'
        self._model.to(self._device)
        self.sample_rate = self._model.config.sampling_rate
        app.logger.info(f"MMS-TTS loaded on {self._device}, sample_rate={self.sample_rate}.")

    def synthesize(self, text, voice=None, speed=1.0, language='vi'):
        import torch

        inputs = self._tokenizer(text, return_tensors='pt')
        inputs = {k: v.to(self._device) for k, v in inputs.items()}

        with torch.no_grad():
            output = self._model(**inputs).waveform

        return output.squeeze().cpu().numpy().astype(np.float32)


# ─── Backend Registry ─────────────────────────────────────────────────────────

BACKENDS = {
    'kokoro':     KokoroBackend,
    'piper':      PiperBackend,
    'mms_tts':    MMSTTSBackend,
    'lightspeed': LightSpeedBackend,
    'vietTTS':    VietTTSBackend,
    'viXTTS':     ViXTTSBackend,
    'edge_tts':   EdgeTTSBackend,
}

_loaded: dict = {}   # key → loaded TTSBackend instance

def get_backend(key: str) -> TTSBackend:
    if key not in BACKENDS:
        key = DEFAULT_MODEL
    if key not in _loaded:
        inst = BACKENDS[key]()
        inst.load()
        _loaded[key] = inst
    return _loaded[key]

# ─── Helpers ──────────────────────────────────────────────────────────────────

def split_text(text, max_chars=200):
    sentences = re.split(r'(?<=[.!?])\s+|\n+', text.strip())
    chunks, current = [], ''
    for sent in sentences:
        sent = sent.strip()
        if not sent:
            continue
        if len(current) + len(sent) + 1 <= max_chars:
            current = (current + ' ' + sent).strip()
        else:
            if current:
                chunks.append(current)
            current = sent[:max_chars]
    if current:
        chunks.append(current)
    return chunks or [text]

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.route('/health', methods=['GET'])
def health():
    models = {}
    for key, cls in BACKENDS.items():
        meta = cls()   # instantiate without load() to read static attrs
        models[key] = {
            'label': meta.name,
            'voices': meta.voices,
            'voice_labels': meta.voice_labels,
            'languages': meta.languages,
            'language_labels': meta.language_labels(),
        }
    return jsonify({'status': 'healthy', 'default_model': DEFAULT_MODEL, 'models': models})


@app.route('/generate', methods=['POST'])
def generate():
    data = request.get_json() or {}
    text = data.get('text', '').strip()
    voice = data.get('voice')
    speed = float(data.get('speed', 1.0))
    language = data.get('language', 'vi')
    model_key = data.get('model', DEFAULT_MODEL)
    if not text:
        return jsonify({'error': 'No text'}), 400

    try:
        backend = get_backend(model_key)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    chunks = split_text(text)
    app.logger.info(f"[{backend.name}] generate {len(chunks)} chunk(s): {text[:60]}")

    silence = np.zeros(int(backend.sample_rate * 0.25), dtype=np.float32)
    parts = []
    for chunk in chunks:
        try:
            parts.append(backend.synthesize(chunk, voice=voice, speed=speed, language=language))
            parts.append(silence)
        except Exception as e:
            app.logger.error(f"Chunk error: {e}")

    if not parts:
        return jsonify({'error': 'Synthesis failed'}), 500

    wav = np.concatenate(parts)
    buf = io.BytesIO()
    sf.write(buf, wav, backend.sample_rate, format='wav', subtype='PCM_16')
    buf.seek(0)
    return send_file(buf, mimetype='audio/wav', as_attachment=False, download_name='speech.wav')


@app.route('/stream', methods=['POST'])
def stream():
    data = request.get_json() or {}
    text = data.get('text', '').strip()
    voice = data.get('voice')
    speed = float(data.get('speed', 1.0))
    language = data.get('language', 'vi')
    model_key = data.get('model', DEFAULT_MODEL)
    if not text:
        return jsonify({'error': 'No text'}), 400

    try:
        backend = get_backend(model_key)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    chunks = split_text(text)
    MIN_BYTES = int(backend.sample_rate * 0.15 * 2)  # 150 ms PCM16

    def gen():
        buf = b''
        for chunk in chunks:
            try:
                wave = backend.synthesize(chunk, voice=voice, speed=speed, language=language)
                buf += (np.clip(wave, -1, 1) * 32767).astype(np.int16).tobytes()
                while len(buf) >= MIN_BYTES:
                    yield buf[:MIN_BYTES]
                    buf = buf[MIN_BYTES:]
            except Exception as e:
                app.logger.error(f"Stream chunk error: {e}")
        if buf:
            yield buf

    return Response(gen(), mimetype='application/octet-stream')


if __name__ == '__main__':
    app.logger.info(f"Default model: {DEFAULT_MODEL} — backends load on first request.")
    app.run(host='0.0.0.0', port=8000, debug=False, threaded=False)
