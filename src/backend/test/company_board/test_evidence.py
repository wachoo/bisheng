from types import SimpleNamespace
from unittest import TestCase

from bisheng.common.board_observation import BoardObservation


class ProviderReceiptTest(TestCase):
    def test_model_tokens_and_categories_are_from_actual_outputs(self):
        observer = BoardObservation("worker", 5)
        observer.start()
        observer.on_llm_start(None, ["question"], run_id="model-1")
        observer.on_llm_end(
            SimpleNamespace(llm_output={"token_usage": {"prompt_tokens": 11, "completion_tokens": 3}}), run_id="model-1"
        )
        self.assertEqual(observer.tokens, {"model-1": (11, 3)})
        observer.document_task = True
        outputs = ["https://files/a.png", "https://files/b.docx", "https://files/c.html", "https://files/code.js"]
        observer.record_outputs({"file_list": outputs})
        observer.register_outputs(outputs[2:], "project", "v1")
        self.assertEqual(
            [observer.categories[observer.output_links[k]] for k in outputs], ["image", "document", "page", "other"]
        )
        (version,) = [k[2] for k in observer.facts if k[0] == "version"]
        self.assertEqual(observer.categories[version], "page")
