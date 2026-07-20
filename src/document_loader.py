import os
from pathlib import Path
from typing import List
from langchain_core.documents import Document
from langchain_text_splitters import MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter
from langchain_community.document_loaders import PyPDFLoader
try:
    from langchain_community.document_loaders import Docx2txtLoader
except ImportError:
    Docx2txtLoader = None
from src import config

# Approximate characters per page — used to assign page numbers to chunks.
# Policy documents typically have ~2000 meaningful characters per page.
CHARS_PER_PAGE = 2000


def parse_section_name(metadata: dict) -> str:
    """Extracts the deepest non-empty section name from header metadata."""
    headers = ["Header 3", "Header 2", "Header 1"]
    for h in headers:
        if h in metadata and metadata[h]:
            return metadata[h].strip()
    return "General"


def load_and_chunk_documents(
    data_dir: Path = config.DATA_DIR,
    only_files: set[str] | None = None,
) -> List[Document]:
    """
    Loads documents from data_dir and chunks them.

    only_files, when given, restricts loading to those filenames — used by
    incremental indexing to chunk just an upload batch.

    Annotates each chunk with:
      - source:   original filename
      - section:  nearest markdown heading
      - chunk_id: unique identifier (filename_N)
      - page:     estimated page number based on cumulative character position
    """
    docs_to_index = []

    def wanted(path: Path) -> bool:
        return only_files is None or path.name in only_files

    # 1. Markdown header splitter — preserves section hierarchy in metadata
    headers_to_split_on = [
        ("#", "Header 1"),
        ("##", "Header 2"),
        ("###", "Header 3"),
    ]
    markdown_splitter = MarkdownHeaderTextSplitter(headers_to_split_on=headers_to_split_on, strip_headers=False)

    # 2. Fine-grained text splitter for large sections
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=config.CHUNK_SIZE,
        chunk_overlap=config.CHUNK_OVERLAP,
        length_function=len,
    )

    # 3. Process markdown files
    for file_path in sorted(p for p in data_dir.glob("*.md") if wanted(p)):
        filename = file_path.name
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        header_splits = markdown_splitter.split_text(content)

        cumulative_chars = 0  # running total to estimate page numbers
        chunk_idx = 0

        for doc in header_splits:
            section_name = parse_section_name(doc.metadata)

            # Page number: section starts at this cumulative character offset
            page_num = (cumulative_chars // CHARS_PER_PAGE) + 1
            cumulative_chars += len(doc.page_content)

            sub_chunks = text_splitter.split_documents([doc])

            for sub_chunk in sub_chunks:
                metadata = {
                    "source": filename,
                    "section": section_name,
                    "chunk_id": f"{filename}_{chunk_idx}",
                    "page": page_num,
                }
                # Preserve any extra header keys (Header 1 / 2 / 3) from splitter
                for k, v in sub_chunk.metadata.items():
                    if k not in metadata:
                        metadata[k] = v

                docs_to_index.append(
                    Document(page_content=sub_chunk.page_content, metadata=metadata)
                )
                chunk_idx += 1

    # 4. Process plain text files
    for file_path in sorted(p for p in data_dir.glob("*.txt") if wanted(p)):
        filename = file_path.name
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        sub_chunks = text_splitter.split_text(content)
        for i, text in enumerate(sub_chunks):
            page_num = (i * config.CHUNK_SIZE // CHARS_PER_PAGE) + 1
            docs_to_index.append(
                Document(
                    page_content=text,
                    metadata={
                        "source": filename,
                        "section": "General",
                        "chunk_id": f"{filename}_{i}",
                        "page": page_num,
                    },
                )
            )

    # 5. Process PDF files
    for file_path in sorted(p for p in data_dir.glob("*.pdf") if wanted(p)):
        filename = file_path.name
        loader = PyPDFLoader(str(file_path))
        pdf_docs = loader.load()
        
        # Split PDF pages further if they are too large
        sub_chunks = text_splitter.split_documents(pdf_docs)
        for i, chunk in enumerate(sub_chunks):
            # PyPDFLoader usually adds 'page' to metadata (0-indexed)
            page_num = chunk.metadata.get("page", 0) + 1
            chunk.metadata.update({
                "source": filename,
                "section": "General",
                "chunk_id": f"{filename}_{i}",
                "page": page_num,
            })
            docs_to_index.append(chunk)

    # 6. Process DOCX files
    if Docx2txtLoader:
        for file_path in sorted(p for p in data_dir.glob("*.docx") if wanted(p)):
            filename = file_path.name
            loader = Docx2txtLoader(str(file_path))
            docx_docs = loader.load()
            
            sub_chunks = text_splitter.split_documents(docx_docs)
            for i, chunk in enumerate(sub_chunks):
                chunk.metadata.update({
                    "source": filename,
                    "section": "General",
                    "chunk_id": f"{filename}_{i}",
                    "page": 1, # docx2txt doesn't support pagination easily
                })
                docs_to_index.append(chunk)

    return docs_to_index


if __name__ == "__main__":
    chunks = load_and_chunk_documents()
    print(f"Loaded {len(chunks)} document chunks.")
    for idx, c in enumerate(chunks[:5]):
        print(
            f"Chunk {idx}: source={c.metadata['source']}  "
            f"section={c.metadata['section']}  "
            f"page={c.metadata['page']}"
        )
        print(f"  Content: {c.page_content[:100]}...\n")
