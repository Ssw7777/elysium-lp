# Example deploy templates

These are generic templates, not a copy of any production host.

- Bind the HTTP server to `127.0.0.1` and put your own reverse proxy in front. Add authentication there before exposing the site. Do not copy a production Caddyfile into this repository.
- Put Bark and wallet settings in an untracked `elysium-lp-report.env` (mode `600` or `640`). Start from `elysium-lp-report.env.example`.
- `DEFAULT_ADDRESS` is the optional read-only owner used by `report.js`. Leave it unset in git.
- `config.json` `ui.hypeReference` stays `0` and `ui.defaultAddress` stays empty in git. Set either one only on the machine that runs the app.
- `elysium-lp-report.timer.example` is optional and local. This repository does not enable it, and it does not add a GitHub Actions schedule. If you install the timer, do not also schedule `scripts/hourly_report.js`: that file only forwards to `report.js`.
- `deploy_vps.sh` installs the localhost web service only after `ELYSIUM_INSTALL=1`. It does not install the Bark timer.
