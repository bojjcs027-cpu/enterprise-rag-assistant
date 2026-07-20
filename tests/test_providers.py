"""Tests that every LLM provider is selectable via env config alone."""

import pytest

from src import config
from src.chain import RAGChain


@pytest.fixture()
def chain():
    c = RAGChain.__new__(RAGChain)  # skip __init__ — no retriever/cache needed
    c._local_llm = None
    c._local_llm_failed = True  # local loader returns None instantly
    return c


class TestProviderSelection:
    def test_claude_selected_with_key(self, chain, monkeypatch):
        monkeypatch.setattr(config, "LLM_PROVIDER", "claude")
        monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "sk-ant-test")
        llm = chain._get_llm()
        from langchain_anthropic import ChatAnthropic
        assert isinstance(llm, ChatAnthropic)
        assert llm.model == config.ANTHROPIC_MODEL

    def test_gemini_selected_with_key(self, chain, monkeypatch):
        monkeypatch.setattr(config, "LLM_PROVIDER", "gemini")
        monkeypatch.setattr(config, "GEMINI_API_KEY", "test-key")
        from langchain_google_genai import ChatGoogleGenerativeAI
        assert isinstance(chain._get_llm(), ChatGoogleGenerativeAI)

    def test_openai_selected_with_key(self, chain, monkeypatch):
        monkeypatch.setattr(config, "LLM_PROVIDER", "openai")
        monkeypatch.setattr(config, "OPENAI_API_KEY", "test-key")
        from langchain_openai import ChatOpenAI
        assert isinstance(chain._get_llm(), ChatOpenAI)

    @pytest.mark.parametrize("provider,key_attr", [
        ("claude", "ANTHROPIC_API_KEY"),
        ("gemini", "GEMINI_API_KEY"),
        ("openai", "OPENAI_API_KEY"),
    ])
    def test_missing_key_falls_back_to_local(self, chain, monkeypatch,
                                             provider, key_attr):
        monkeypatch.setattr(config, "LLM_PROVIDER", provider)
        monkeypatch.setattr(config, key_attr, "")
        # local loader is stubbed to fail → falls through to None (extractive)
        assert chain._get_llm() is None

    def test_model_name_reporting(self, chain, monkeypatch):
        monkeypatch.setattr(config, "ANTHROPIC_MODEL", "claude-opus-4-8")
        assert chain._llm_model_name("claude") == "claude-opus-4-8"
        assert chain._llm_model_name("gemini") == "gemini-1.5-flash"
        assert chain._llm_model_name("openai") == "gpt-4o-mini"
        assert "no LLM" in chain._llm_model_name("extractive_fallback")
