import os
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Base directories
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
VECTOR_DB_DIR = BASE_DIR / os.getenv("VECTOR_DB_DIR", "data/vectorstore")

# Ensure directories exist
DATA_DIR.mkdir(exist_ok=True)

# LLM Configurations
# Options: "local" (HuggingFace local model), "gemini", "openai"
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "local").lower()
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")

# Local LLM (HuggingFace) — used when LLM_PROVIDER=local
LOCAL_LLM_MODEL = os.getenv("LOCAL_LLM_MODEL", "google/flan-t5-base")

# Embedding and Reranking Configurations
EMBEDDING_MODEL_NAME = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
RERANK_MODEL_NAME = os.getenv("RERANK_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")

# Chunking configurations
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", 500))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", 50))

# Retrieval configurations
TOP_K_RETRIEVAL = int(os.getenv("TOP_K_RETRIEVAL", 6))
TOP_K_RERANK = int(os.getenv("TOP_K_RERANK", 3))

# Web Server configurations
HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", 8000))

# CORS: comma-separated list of allowed origins. Defaults cover local dev.
# Set explicitly in production, e.g. CORS_ORIGINS=https://rag.omnicorp.com
CORS_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "CORS_ORIGINS",
        "http://127.0.0.1:8000,http://localhost:8000,http://127.0.0.1:3000,http://localhost:3000",
    ).split(",")
    if o.strip()
]

# ---------------------------------------------------------------------------
# Authentication / Database
# ---------------------------------------------------------------------------
# SQLite by default; point at PostgreSQL in production, e.g.
#   DATABASE_URL=postgresql+psycopg2://user:pass@host:5432/omnicorp
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{BASE_DIR / 'data' / 'auth.db'}")

# Rate limiting for login/signup: N attempts per client IP per window.
RATE_LIMIT_AUTH_ATTEMPTS = int(os.getenv("RATE_LIMIT_AUTH_ATTEMPTS", 10))
RATE_LIMIT_AUTH_WINDOW_SECONDS = int(os.getenv("RATE_LIMIT_AUTH_WINDOW_SECONDS", 60))

# JWT settings. JWT_SECRET_KEY MUST be set in .env — never hardcoded.
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 30))
REFRESH_TOKEN_EXPIRE_DAYS = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", 30))

def get_llm_config():
    """Returns active LLM configurations and warning logs if keys are missing."""
    config = {
        "provider": LLM_PROVIDER,
        "has_gemini": bool(GEMINI_API_KEY),
        "has_openai": bool(OPENAI_API_KEY),
        "local_model": LOCAL_LLM_MODEL,
    }
    return config
