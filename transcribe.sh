#!/bin/bash

if [ $# -ne 1 ]; then
  echo "Usage: $0 <input_audio_file>"
  exit 1
fi

INPUT_FILE="$1"
TEMP_WAV="/tmp/temp_audio.wav"
HIGHPASS_WAV="/tmp/highpass.wav"
CLEAN_WAV="/tmp/output_clean.wav"
FINAL_WAV="/tmp/output.wav"

# Step 0: Convert to WAV
echo "Step 0: Convert to WAV"
ffmpeg -i "$INPUT_FILE" -vn -acodec pcm_s16le -ar 16000 -ac 1 "$TEMP_WAV"

# Step 1: Highpass Filter
echo "Step 1: Highpass Filter"
sox "$TEMP_WAV" "$HIGHPASS_WAV" highpass 300

# Step 2: Lowpass Filter
echo "Step 2: Lowpass Filter"
sox "$HIGHPASS_WAV" "$CLEAN_WAV" lowpass 3000

# Step 3: Volume Normalization
echo "Step 3: Volume Normalization"
sox --norm "$CLEAN_WAV" "$FINAL_WAV"

# Step 4: Run Transcription
echo "Step 4: Run Transcription"
# Prefer local venv if present
if [ -x "./.venv/bin/python" ]; then
  ./.venv/bin/python transcribe_with_progress.py "$FINAL_WAV"
else
  python3 transcribe_with_progress.py "$FINAL_WAV"
fi

# Clean up temporary files
rm "$TEMP_WAV" "$HIGHPASS_WAV" "$CLEAN_WAV" "$FINAL_WAV"
