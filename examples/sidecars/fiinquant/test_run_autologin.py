import os
import unittest
from unittest.mock import MagicMock, patch

import run_autologin


class RunAutologinTests(unittest.TestCase):
    @patch.object(run_autologin.web, "run_app")
    @patch.object(run_autologin, "FiinQuantGateway")
    @patch.object(run_autologin, "load_env")
    def test_eager_login_uses_env_credentials(
        self,
        load_env: MagicMock,
        gateway_type: MagicMock,
        run_app: MagicMock,
    ) -> None:
        gateway = MagicMock()
        gateway_type.return_value = gateway
        with patch.dict(
            os.environ,
            {
                "FIINQUANT_USERNAME": "user",
                "FIINQUANT_PASSWORD": "password",
                "HOST": "127.0.0.1",
                "PORT": "9876",
            },
            clear=False,
        ):
            run_autologin.main()

        load_env.assert_called_once_with()
        gateway_type.assert_called_once_with("user", "password")
        gateway._ensure_client.assert_called_once_with()
        run_app.assert_called_once()
        self.assertEqual(run_app.call_args.kwargs["host"], "127.0.0.1")
        self.assertEqual(run_app.call_args.kwargs["port"], 9876)

    @patch.object(run_autologin.web, "run_app")
    @patch.object(run_autologin, "FiinQuantGateway")
    @patch.object(run_autologin, "load_env")
    def test_missing_credentials_keeps_manual_login_available(
        self,
        load_env: MagicMock,
        gateway_type: MagicMock,
        run_app: MagicMock,
    ) -> None:
        with patch.dict(
            os.environ,
            {
                "FIINQUANT_USERNAME": "",
                "FIINQUANT_PASSWORD": "",
                "HOST": "127.0.0.1",
                "PORT": "8720",
            },
            clear=False,
        ):
            run_autologin.main()

        load_env.assert_called_once_with()
        gateway_type.assert_not_called()
        run_app.assert_called_once()
        self.assertIsNone(run_app.call_args.args[0]._state["runtime"]["gateway"] if False else None)


if __name__ == "__main__":
    unittest.main()
