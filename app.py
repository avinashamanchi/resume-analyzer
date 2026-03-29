import os
import json
import base64
import pdfplumber
import io
from groq import Groq
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder="static")
CORS(app)

# ── Put your Groq API key here ────────────────────────────────────────────────
API_KEY = os.environ.get("GROQ_API_KEY", "YOUR_API_KEY_HERE")
# ─────────────────────────────────────────────────────────────────────────────

client = Groq(api_key=API_KEY)

SYSTEM_PROMPT = """You are an expert resume analyst and career coach. Analyze the provided resume thoroughly.
If a job description is provided, match keywords and tailor all feedback to that role.
If no job description is provided, give general best-practice feedback.

Return ONLY a valid JSON object with this exact structure (no markdown, no backticks, no explanation, just raw JSON):
{
  "score": <number 0-100>,
  "scoreLabel": <"Weak" | "Needs Work" | "Good" | "Strong" | "Excellent">,
  "scoreSummary": "<1-2 sentence overall summary>",
  "matchedKeywords": ["<keyword>"],
  "missingKeywords": ["<keyword>"],
  "strengths": ["<strength>"],
  "improvements": ["<improvement>"],
  "powerBullets": ["<rewritten bullet>"],
  "verdict": "<2-3 sentence blunt recruiter verdict>"
}"""


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/analyze", methods=["POST"])
def analyze():
    try:
        data = request.get_json()
        if not data or "pdf_base64" not in data:
            return jsonify({"error": "No PDF data provided"}), 400

        pdf_b64 = data["pdf_base64"]
        job_desc = data.get("job_description", "").strip()

        # Extract text from PDF since Groq doesn't accept PDFs directly
        pdf_bytes = base64.b64decode(pdf_b64)
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            resume_text = "\n".join(page.extract_text() or "" for page in pdf.pages)

        if not resume_text.strip():
            return jsonify({"error": "Could not extract text from PDF. Make sure it's not a scanned image."}), 400

        user_text = (
            f"Analyze this resume against the following job description:\n\n{job_desc}\n\nRESUME:\n{resume_text}"
            if job_desc
            else f"Analyze this resume and provide detailed feedback.\n\nRESUME:\n{resume_text}"
        )

        response = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_text},
            ],
            max_tokens=1500,
        )

        raw = response.choices[0].message.content.strip()
        raw = raw.replace("```json", "").replace("```", "").strip()
        result = json.loads(raw)
        return jsonify(result)

    except json.JSONDecodeError as e:
        return jsonify({"error": f"Failed to parse AI response: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    if API_KEY == "YOUR_API_KEY_HERE":
        print("\n⚠️  WARNING: Add your Groq API key before using!")
        print("   Then run: export GROQ_API_KEY=gsk_...\n")
    print("🚀 Resume Analyzer running at http://localhost:5000")
    app.run(debug=True, port=5000, host="0.0.0.0")