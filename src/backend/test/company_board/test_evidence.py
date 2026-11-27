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
        outputs = ["https://files/a.png", "https://files/b.docx", "https://files/c.html", "https://files/code.js"]
        observer.record_outputs({"file_list": outputs})
        self.assertFalse(any(key[0] == "file" for key in observer.facts))
        self.assertEqual(observer.register_outputs(outputs[:2]), "Delivery recorded.")
        self.assertEqual(observer.register_outputs(outputs[2:], "project", "v1"), "Delivery recorded.")
        self.assertEqual(
            [observer.categories[observer.output_links[k]] for k in outputs], ["image", "document", "page", "other"]
        )
        (version,) = [k[2] for k in observer.facts if k[0] == "version"]
        self.assertEqual(observer.categories[version], "page")
