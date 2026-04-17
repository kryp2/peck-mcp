"""Re-query overlay.peck.to and print fresh numbers for content.py.

Not a code generator — prints a block you paste into content.py so
the judges-facing copy stays under human review. Run the morning of
submission:

    .venv/bin/python scripts/refresh_stats.py < /dev/null
"""
import json
import urllib.request

OVERLAY = "https://overlay.peck.to"


def fetch(path):
    with urllib.request.urlopen(f"{OVERLAY}{path}", timeout=15) as r:
        return json.loads(r.read())


def main():
    stats = fetch("/v1/stats")["data"]
    apps = fetch("/v1/apps?limit=500")["data"]

    total_posts = stats["total_posts"]
    total_users = stats["total_users"]
    total_apps = len(apps)
    top12 = apps[:12]

    print("# paste into content.py STATS (value column)")
    print(f"On-chain posts indexed  → {total_posts:,}")
    print(f"Distinct apps in feed   → {total_apps}")
    print(f"Sovereign on-chain users → {total_users}")
    print()
    print("# paste into content.py APP_LEADERBOARD")
    print("APP_LEADERBOARD = [")
    for a in top12:
        name = a["app"]
        count = a["count"]
        print(f'    ({name!r:<28}, {count:>7}),')
    print("]")
    print(f"APP_TAIL_COUNT = {total_apps - len(top12)}")


if __name__ == "__main__":
    main()
