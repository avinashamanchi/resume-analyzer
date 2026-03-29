# Resume.AI — Local Setup

## Quick Start (3 steps)

### 1. Install dependencies
```bash
pip install -r requirements.txt
```

### 2. Add your Anthropic API key
**Option A** — Set environment variable (recommended):
```bash
# Mac/Linux
export ANTHROPIC_API_KEY=sk-ant-your-key-here

# Windows (PowerShell)
$env:ANTHROPIC_API_KEY="sk-ant-your-key-here"
```

**Option B** — Edit `app.py` directly:
```python
API_KEY = "sk-ant-your-key-here"   # line 10
```

Get your key at: https://console.anthropic.com

### 3. Run the server
```bash
python app.py
```

Open your browser to: **http://localhost:5000**

---

## How to use
1. Drop in a PDF resume
2. (Optional) paste a job description for keyword matching
3. Click **Analyze Resume** — takes ~10 seconds

## Project structure
```
resume-analyzer/
├── app.py              ← Flask backend (API proxy)
├── requirements.txt    ← Python dependencies
├── README.md
└── static/
    └── index.html      ← Frontend UI
```
# resume-analyzer
# resume-analyzer
