import sys
import json
from transformers import AutoTokenizer, AutoModelForCausalLM

import sys
sys.stdout.reconfigure(encoding='utf-8')

# Load lightweight LLM
model_name = "Qwen/Qwen2.5-1.5B-Instruct"
tokenizer = AutoTokenizer.from_pretrained(model_name)
model = AutoModelForCausalLM.from_pretrained(model_name)

# Text input from backend
text = sys.argv[1]

prompt = f"""
Bạn là một chuyên gia phỏng vấn nhân sự.

Dựa trên câu trả lời sau của ứng viên:

\"\"\"{text}\"\"\"

Hãy tạo:
1) **Tóm tắt ngắn gọn ứng viên đã nói gì**
2) **Đưa ra 2–3 nhận xét về điểm mạnh/yếu**
3) **Gợi ý cải thiện câu trả lời cho tốt hơn**

Viết bằng tiếng Việt, tự nhiên, ngắn gọn.
"""

inputs = tokenizer(prompt, return_tensors="pt")
outputs = model.generate(**inputs, max_new_tokens=180)
feedback = tokenizer.decode(outputs[0], skip_special_tokens=True)

# Clean prompt from output
feedback = feedback.replace(prompt, "").strip()

print(json.dumps({
    "summary": feedback
}, ensure_ascii=False))
