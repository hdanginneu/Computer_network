import express from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";

const router = express.Router();
const upload = multer({ dest: "uploads/" });

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

router.post("/upload", upload.single("video"), async (req, res) => {
  try {
    const filePath = req.file.path;

    // 1. Transcribe video
    const transcript = await client.audio.transcriptions.create({
      model: "gpt-4o-transcribe",
      file: fs.createReadStream(filePath)
    });

    const text = transcript.text;

    // 2. Summary + Feedback
    const aiResponse = await client.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        {
          role: "user",
          content: `
Tạo summary + nhận xét + gợi ý dựa trên transcript sau:
${text}
`
        }
      ]
    });

    const script = aiResponse.choices[0].message.content;

    res.json({
      transcript: text,
      summary: script
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Processing failed" });
  }
});

export default router;
