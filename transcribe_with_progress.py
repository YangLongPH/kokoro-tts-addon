import os
import sys
import wave
import json
import vosk
from tqdm import tqdm

def transcribe_chunk(chunk, recognizer):
    recognizer.AcceptWaveform(chunk)
    result = json.loads(recognizer.Result())
    return result.get('text', '')

def main():
    if len(sys.argv) != 2:
        print("Usage: python3 transcribe_with_progress.py <input_wav_file>")
        sys.exit(1)
    
    wav_path = sys.argv[1]
    model_path = "vosk-model-en-us-0.42-gigaspeech"
    if not os.path.exists(model_path):
        print(f"Model path '{model_path}' does not exist.")
        sys.exit(1)
    
    wf = wave.open(wav_path, "rb")
    if wf.getnchannels() != 1 or wf.getsampwidth() != 2 or wf.getframerate() != 16000:
        print("Audio file must be WAV format mono PCM 16000Hz.")
        sys.exit(1)
    
    model = vosk.Model(model_path)
    recognizer = vosk.KaldiRecognizer(model, wf.getframerate())

    print("Transcribing...")
    with open("transcript.txt", "w") as f:
        while True:
            data = wf.readframes(4000)
            if len(data) == 0:
                break
            if recognizer.AcceptWaveform(data):
                result = json.loads(recognizer.Result())
                f.write(result.get('text', '') + "\n")
                f.flush()  # Ensure the content is written to the file immediately

        # Append final result
        result = json.loads(recognizer.FinalResult())
        f.write(result.get('text', '') + "\n")
    
    print("Transcription complete. Check the transcript.txt file.")

if __name__ == "__main__":
    main()

