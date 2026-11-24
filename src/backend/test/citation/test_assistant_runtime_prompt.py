"""Assistant retrieval results must carry usable references into the final answer."""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from bisheng.api.services import assistant_agent
from bisheng.citation.domain.services.citation_prompt_helper import CITATION_PROMPT_RULES


class AssistantPromptTest(unittest.IsolatedAsyncioTestCase):
    async def test_prompt_matches_executor_and_available_sources(self):
        for mode in ("function call", "ReAct"):
            for with_sources in (True, False):
                with self.subTest(mode=mode, with_sources=with_sources):
                    agent = SimpleNamespace(
                        llm_agent_executor=mode,
                        agent_executor_dict={},
                        assistant=SimpleNamespace(prompt="Answer succinctly."),
                        llm=SimpleNamespace(model_name="test"),
                        tools=[],
                        has_citation_tools=lambda enabled=with_sources: enabled,
                    )
                    attribute = "ConfigurableAssistant" if mode == "ReAct" else "create_react_agent"
                    with patch.object(assistant_agent, attribute) as factory:
                        await assistant_agent.AssistantAgent.init_agent(agent)
                    prompt_key = "assistant_message" if mode == "ReAct" else "prompt"
                    prompt = factory.call_args.kwargs[prompt_key]
                    self.assertTrue(prompt.startswith(agent.assistant.prompt))
                    self.assertEqual(prompt.count(CITATION_PROMPT_RULES), int(with_sources))


if __name__ == "__main__":
    unittest.main()
