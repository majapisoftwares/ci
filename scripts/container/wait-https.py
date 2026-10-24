import argparse
import json
import subprocess
import time
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("urls", nargs="+")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--resolve-ip")
    arguments = parser.parse_args()
    if not 1 <= arguments.timeout <= 300:
        parser.error("timeout must be between 1 and 300 seconds")
    for url in arguments.urls:
        if urlsplit(url).scheme != "https" or not urlsplit(url).hostname:
            parser.error("preview URLs must use HTTPS")
    allowed_hosts = {urlsplit(url).netloc for url in arguments.urls}
    deadline = time.monotonic() + arguments.timeout
    pending = set(arguments.urls)
    while pending and time.monotonic() < deadline:
        for url in list(pending):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            command = [
                "curl", "--fail", "--silent", "--show-error",
                "--location", "--max-redirs", "3", "--proto-redir", "=https",
                "--write-out", "\n%{url_effective}",
                "--connect-timeout", "5", "--max-time", str(min(15, remaining)),
            ]
            if arguments.resolve_ip:
                command.extend([
                    "--resolve",
                    f"{urlsplit(url).hostname}:443:{arguments.resolve_ip}",
                ])
            command.append(url.rstrip("/") + "/api/health/ready")
            try:
                response = subprocess.run(
                    command, capture_output=True, text=True, timeout=remaining,
                )
                if response.returncode != 0:
                    continue
                body, final_url = response.stdout.rsplit("\n", 1)
                if (
                    urlsplit(final_url).netloc not in allowed_hosts
                    or urlsplit(final_url).path != "/api/health/ready"
                ):
                    continue
                payload = json.loads(body)
                if (
                    isinstance(payload, dict)
                    and payload.get("ok") is True
                    and payload.get("checks", {}).get("postgres") is True
                    and payload.get("checks", {}).get("redis") is True
                ):
                    pending.remove(url)
                    print(f"Preview HTTPS and dependencies ready: {url}", flush=True)
            except (subprocess.TimeoutExpired, ValueError, AttributeError):
                pass
        if pending:
            time.sleep(max(0, min(5, deadline - time.monotonic())))
    if pending:
        raise SystemExit("Preview HTTPS readiness timed out: " + ", ".join(sorted(pending)))


if __name__ == "__main__":
    main()
