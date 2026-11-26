"""Inspect only the test QA library using the application's two retrieval clients."""

import argparse
import asyncio
import json

from bisheng.common.services.config_service import settings
from bisheng.core.context.manager import close_app_context, initialize_app_context
from bisheng.core.context.tenant import tenant_execution_scope
from bisheng.knowledge.domain.knowledge_rag import KnowledgeRag
from bisheng.knowledge.domain.models.knowledge import KnowledgeDao
from bisheng.knowledge.domain.services.knowledge_utils import KnowledgeUtils


async def inspect(args):
    await initialize_app_context(config=settings, instance_role="script")
    try:
        with tenant_execution_scope(args.tenant):
            kb = await KnowledgeDao.aquery_by_id(args.knowledge)
            if not kb or kb.name not in {"物资采购定价指引", "采集验收1126·采购规则问答库"} or kb.type != 1:
                raise ValueError("The specified ID is not the acceptance QA library.")
            milvus = await KnowledgeRag.init_knowledge_milvus_vectorstore(args.user, kb)
            es = await KnowledgeRag.init_knowledge_es_vectorstore(kb)
            results = []
            original = kb.name == "采集验收1126·采购规则问答库"
            exact = "验收采购报价的复核规则是什么？" if original else "采购报价应如何统一比价口径？"
            for query in (exact, "采购比价时怎样核对含税报价？"):
                for backend, store in (("Milvus", milvus), ("Elasticsearch", es)):
                    documents = await store.as_retriever().ainvoke(query)
                    rows = []
                    for doc in documents:
                        extra = doc.metadata.get("extra") or {}
                        if isinstance(extra, str):
                            extra = json.loads(extra)
                        rows.append({
                            "file": doc.metadata.get("file_id"),
                            "question": doc.page_content,
                            "stored_answer": extra.get("answer"),
                            "assistant_chunk": KnowledgeUtils.format_retrieved_chunk(doc, kb.name),
                        })
                    results.append({"query": query, "backend": backend, "hits": rows})
            print("QA_EVIDENCE " + json.dumps(results, ensure_ascii=False))
    finally:
        await close_app_context()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--tenant", type=int, required=True)
    parser.add_argument("--knowledge", type=int, required=True)
    parser.add_argument("--user", type=int, required=True)
    asyncio.run(inspect(parser.parse_args()))
