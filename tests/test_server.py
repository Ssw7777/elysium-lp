import json
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import server

ROOT = Path(__file__).resolve().parents[1]


class ElysiumConfigTests(unittest.TestCase):
    def test_config(self):
        config = server.load_config(ROOT / "config.json")
        self.assertEqual(config["network"]["chainId"], 99901)
        self.assertEqual(config["uniswap"]["poolId"][:10], "0xc96bfd21")
        self.assertEqual(config["uniswap"]["poolKey"]["currency0"], "0x0000000000000000000000000000000000000000")
        self.assertEqual(config["uniswap"]["fee"], 10000)

    def test_wrong_chain_rejected(self):
        config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
        config["uniswap"]["poolId"] = "0x1234"
        with self.assertRaises(ValueError):
            server.validate_config(config)

    def test_read_only_methods(self):
        self.assertIn("write methods", server.validate_rpc_payload({"method": "eth_sendRawTransaction", "params": []}))
        self.assertIsNone(server.validate_rpc_payload({"method": "eth_call", "params": [{"to": "0x0"}]}))


class PrefixHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config = server.load_config(ROOT / "config.json")
        pool = server.RpcPool(config["network"]["rpcUrls"], cooldown=0)
        market = server.MarketCache(url="https://invalid", ttl=0)
        market._price = 1.0
        market._fetched_at = 1.0
        cls.state = server.AppState(config=config, rpc=pool, market=market, logger=server.setup_logging(False))
        cls.httpd = server.LocalServer(("127.0.0.1", 0), cls.state)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=5)

    def test_prefixed_config(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/elysium-lp/api/config", timeout=5) as r:
            data = json.loads(r.read())
        self.assertEqual(data["network"]["chainId"], 99901)
        self.assertEqual(data["uniswap"]["poolId"][:10], "0xc96bfd21")

    def test_prefixed_index(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/elysium-lp/", timeout=5) as r:
            body = r.read().decode()
        self.assertIn("Elysium LP", body)
        self.assertIn('base href="/elysium-lp/"', body)

    def test_traversal(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(f"http://127.0.0.1:{self.port}/elysium-lp/../server.py", timeout=5)
        self.assertEqual(ctx.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
