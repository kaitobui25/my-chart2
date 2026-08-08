import os
import unittest
from unittest.mock import MagicMock, patch

import run_autologin


class RunAutologinTests(unittest.TestCase):
    @patch.object(run_autologin.web, "run_app")
    @patch.object(run_autologin, "build_app")
    @patch.object(run_autologin, "FiinQuantGateway")
    @patch.object(run_autologin, "load_env")
    def test_eager_login_uses_env_credentials(
        self,
        load_env: MagicMock,
        gateway_type: MagicMock,
        build_app: MagicMock,
        run_app: MagicMock,
    ) -> None:
        gateway = MagicMock()
        app = object()
        gateway_type.return_value = gateway
        build_app.return_value = app
        with patch.dict(
            os.environ,
            {
                "FIINQUANT_USERNAME": "user",
                "FIINQUANT_PASSWORD": "test-value",  # pragma: allowlist secret
                "HOST": "127.0.0.1",
                "PORT": "9876",
            },
            clear=False,
        ):
            run_autologin.main()

        load_env.assert_called_once_with()
        gateway_type.assert_called_once_with("user", "test-value")
        gateway._ensure_client.assert_called_once_with()
        build_app.assert_called_once_with(gateway)
        run_app.assert_called_once_with(app, host="127.0.0.1", port=9876, print=None)

    @patch.object(run_autologin.web, "run_app")
    @patch.object(run_autologin, "build_app")
    @patch.object(run_autologin, "FiinQuantGateway")
    @patch.object(run_autologin, "load_env")
    def test_missing_credentials_keeps_manual_login_available(
        self,
        load_env: MagicMock,
        gateway_type: MagicMock,
        build_app: MagicMock,
        run_app: MagicMock,
    ) -> None:
        app = object()
        build_app.return_value = app
        with patch.dict(
            os.environ,
            {
                "FIINQUANT_USERNAME": "",
                "FIINQUANT_PASSWORD": "",  # pragma: allowlist secret
                "HOST": "127.0.0.1",
                "PORT": "8720",
            },
            clear=False,
        ):
            run_autologin.main()

        load_env.assert_called_once_with()
        gateway_type.assert_not_called()
        build_app.assert_called_once_with(None)
        run_app.assert_called_once_with(app, host="127.0.0.1", port=8720, print=None)


if __name__ == "__main__":
    unittest.main()
