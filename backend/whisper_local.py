import sys
import json
import librosa
from transformers import WhisperProcessor, WhisperForConditionalGeneration
import sys
sys.stdout.reconfigure(encoding='utf-8')

audio_path = sys.argv[1]
model_name = "openai/whisper-large-v3"
processor = WhisperProcessor.from_pretrained(model_name)
model = WhisperForConditionalGeneration.from_pretrained(model_name)

audio, sr = librosa.load(audio_path, sr=16000)

inputs = processor(audio, sampling_rate=16000, return_tensors="pt")
inputs["forced_decoder_ids"] = processor.get_decoder_prompt_ids(language="vi", task="transcribe")

pred = model.generate(**inputs)
text = processor.batch_decode(pred, skip_special_tokens=True)[0]

sentences = [s.strip() for s in text.split(".") if s.strip()]
summary = ". ".join(sentences[:2]) + "..."

out = {
    "transcript": text,
    "summary": summary
}

safe = json.dumps(out, ensure_ascii=False).encode("utf-8", errors="ignore").decode("utf-8")
print(safe)
