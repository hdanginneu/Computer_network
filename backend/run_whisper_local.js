import { spawn } from "child_process";
import path from "path";

export function runWhisperLocal(wavPath) {
  return new Promise((resolve, reject) => {
    const script = path.join(process.cwd(), "whisper_local.py");

    const py = spawn("py", ["-3.10", script, wavPath]);

    let output = "";
    let errOutput = "";

    py.stdout.on("data", (data) => {
      output += data.toString();
    });

    py.stderr.on("data", (data) => {
      errOutput += data.toString();
    });

    py.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error("Python exited with " + code + "\n" + errOutput));
      }
      try {
        const json = JSON.parse(output.trim());
        resolve(json);
      } catch (e) {
        reject(new Error("Invalid JSON from Python:\n" + output));
      }
    });
  });
}
