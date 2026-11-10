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
        pools = {item["fee"]: item for item in config["uniswap"]["pools"]}
        self.assertEqual(pools[10000]["poolId"], "0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac")
        self.assertEqual(pools[10000]["tickSpacing"], 200)
        self.assertEqual(pools[10000]["poolKey"]["hooks"], "0x0000000000000000000000000000000000000000")
        self.assertEqual(pools[3000]["poolId"], "0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a")
        self.assertEqual(pools[3000]["tickSpacing"], 60)
        self.assertEqual(pools[3000]["poolKey"]["fee"], 3000)
        self.assertEqual(pools[3000]["poolKey"]["tickSpacing"], 60)
        self.assertEqual(pools[3000]["poolKey"]["hooks"], "0x0000000000000000000000000000000000000000")
        self.assertEqual(config["ui"]["defaultAddress"], "")
        self.assertEqual(config["ui"]["hypeReference"], 0)
        blob = json.dumps(config).lower()
        self.assertNotIn("tokenid", blob)
        self.assertNotIn("baseline", blob)
        self.assertNotIn("nft", blob)

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
        self.assertEqual(len(data["uniswap"]["pools"]), 2)
        self.assertEqual(data["ui"]["defaultAddress"], "")
        self.assertEqual(data["ui"]["hypeReference"], 0)

    def test_prefixed_index(self):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/elysium-lp/", timeout=5) as r:
            body = r.read().decode()
        self.assertIn("Elysium LP", body)
        self.assertIn('base href="/elysium-lp/"', body)
        self.assertIn('id="poolSelect"', body)
        self.assertIn('id="composerPoolSelect"', body)
        self.assertIn("0.3%", body)
        self.assertIn("ui.defaultAddress", body)

    def test_fee_mismatch_rejected(self):
        config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
        config["uniswap"]["pools"][1]["fee"] = 10000
        with self.assertRaises(ValueError) as ctx:
            server.validate_config(config)
        self.assertIn("does not match poolKey", str(ctx.exception))

    def test_placeholder_wallet_rejected(self):
        config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
        config["ui"]["defaultAddress"] = "0xYOUR_WALLET_ADDRESS"
        with self.assertRaises(ValueError) as ctx:
            server.validate_config(config)
        self.assertIn("defaultAddress", str(ctx.exception))

    def test_negative_reference_rejected(self):
        config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
        config["ui"]["hypeReference"] = -1
        with self.assertRaises(ValueError) as ctx:
            server.validate_config(config)
        self.assertIn("hypeReference", str(ctx.exception))

    def test_traversal(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(f"http://127.0.0.1:{self.port}/elysium-lp/../server.py", timeout=5)
        self.assertEqual(ctx.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
