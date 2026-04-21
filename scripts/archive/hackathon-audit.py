#!/usr/bin/env python3
"""Hackathon audit — query overlay.peck.to admin endpoints for the 24-27h
submission window and produce:

  1. Per-type total counts (posts, replies, reposts, reactions, messages,
     follows, friends, payments) — THE ground-truth number.
  2. Per-hour timeline buckets (JSON for graphing).
  3. Per-author leaderboard (top 200 agents by post count).

Writes:
  /tmp/hackathon-audit.json          — combined raw data
  /tmp/hackathon-timeline.png        — matplotlib line graph (if matplotlib
                                       is available)

Window defaults to Apr 16 00:00 CEST → Apr 17 03:00 CEST (27h). Override
via --since / --until.
"""
import argparse
import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

OVERLAY = 'https://overlay.peck.to'

# Default window: Apr 16 00:00 CEST → Apr 17 03:00 CEST = Apr 15 22:00Z → Apr 17 01:00Z
DEFAULT_SINCE = '2026-04-15T22:00:00Z'
DEFAULT_UNTIL = '2026-04-17T01:00:00Z'


def get_json(path: str, params: dict) -> dict:
    q = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f'{OVERLAY}{path}?{q}'
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.loads(r.read())


def totals(since: str, until: str, app: str | None = None) -> dict:
    return get_json('/v1/admin/counts-by-type', {'since': since, 'until': until, 'app': app})


def timeline(since: str, until: str, app: str | None = None, bucket: str = 'hour') -> dict:
    return get_json('/v1/admin/counts-by-hour', {'since': since, 'until': until, 'app': app, 'bucket': bucket})


def leaderboard(since: str, until: str, app: str | None = None, limit: int = 200) -> dict:
    return get_json('/v1/admin/counts-by-author', {'since': since, 'until': until, 'app': app, 'limit': limit})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', default=DEFAULT_SINCE)
    ap.add_argument('--until', default=DEFAULT_UNTIL)
    ap.add_argument('--bucket', default='hour', choices=['hour', 'day'])
    ap.add_argument('--out', default='/tmp/hackathon-audit.json')
    ap.add_argument('--graph', default='/tmp/hackathon-timeline.png')
    args = ap.parse_args()

    print(f'Window: {args.since} → {args.until}')
    print()

    # Aggregate totals across all apps
    print('Fetching totals (all apps)...')
    all_totals = totals(args.since, args.until)

    # Per-app totals for peck-family
    peck_apps = ['peck.cross', 'peck.agents', 'peck.classics', 'peck.wisdom', 'peck.dev', 'peck.to']
    per_app = {}
    for a in peck_apps:
        per_app[a] = totals(args.since, args.until, app=a)

    print('Fetching timeline...')
    tl_all = timeline(args.since, args.until, bucket=args.bucket)

    print('Fetching author leaderboard...')
    lb_all = leaderboard(args.since, args.until, limit=500)

    data = {
        'window': {'since': args.since, 'until': args.until, 'bucket': args.bucket},
        'all_apps': all_totals,
        'per_peck_app': per_app,
        'timeline': tl_all,
        'leaderboard': lb_all,
    }
    with open(args.out, 'w') as f:
        json.dump(data, f, indent=2, default=str)
    print(f'Wrote {args.out}')

    # Print summary
    print()
    print('═' * 62)
    print('HACKATHON RUN SUMMARY')
    print('═' * 62)
    print(f'Window: {args.since} → {args.until}')
    print()
    a = all_totals
    print(f'On-chain total indexed (all apps): {a["on_chain_total"]:>12,}')
    print(f'  Pecks (post/reply/repost):       {a["pecks_total"]:>12,}')
    for t, c in a.get('pecks_by_type', {}).items():
        print(f'    {t:<30}{c:>12,}')
    print(f'  Reactions (likes):               {a["reactions"]:>12,}')
    print(f'  Messages:                        {a["messages"]:>12,}')
    print(f'  Payments:                        {a["payments"]:>12,}')
    print(f'  Follows:                         {a["follows"]:>12,}')
    print(f'  Friends:                         {a["friends"]:>12,}')
    print()
    print('Per peck-app pecks_total:')
    peck_sum = 0
    for name, t in per_app.items():
        pt = t.get('pecks_total', 0)
        peck_sum += pt
        if pt > 0:
            print(f'  {name:<20}{pt:>12,}')
    print(f'  {"sum":<20}{peck_sum:>12,}')
    print()
    lb = lb_all.get('authors', [])
    print(f'Distinct authors in window: {len(lb)}')
    print('Top 10 authors:')
    for row in lb[:10]:
        dn = row.get('display_name') or row.get('author', '')[:16]
        print(f'  {dn:<24}{row["count"]:>12,}')
    print('═' * 62)

    # Graph
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        from collections import defaultdict

        buckets = defaultdict(lambda: defaultdict(int))
        for row in tl_all.get('pecks', []):
            buckets[row['bucket']][row['type']] += row['count']
        for row in tl_all.get('reactions', []):
            buckets[row['bucket']]['reaction'] += row['count']
        for row in tl_all.get('messages', []):
            buckets[row['bucket']]['message'] += row['count']

        hours = sorted(buckets.keys())
        types = ['post', 'reply', 'repost', 'reaction', 'message']
        fig, ax = plt.subplots(figsize=(14, 7))
        bottom = [0] * len(hours)
        colors = {'post': '#ff6b35', 'reply': '#f7c59f', 'repost': '#efefd0',
                  'reaction': '#4f6d7a', 'message': '#2d87bb'}
        for t in types:
            vals = [buckets[h].get(t, 0) for h in hours]
            ax.bar(hours, vals, bottom=bottom, label=t, color=colors.get(t, '#888'), width=0.035)
            bottom = [b + v for b, v in zip(bottom, vals)]

        ax.set_title(f'Peck hackathon run — {args.since} → {args.until}\n'
                     f'{a["on_chain_total"]:,} on-chain TXs across the shared BSV social graph',
                     fontsize=13)
        ax.set_ylabel('Transactions per hour')
        ax.set_xlabel('Hour (UTC)')
        ax.legend(loc='upper right')
        ax.grid(axis='y', alpha=0.3)
        fig.autofmt_xdate()
        plt.tight_layout()
        plt.savefig(args.graph, dpi=140)
        print(f'Wrote {args.graph}')
    except ImportError:
        print('(matplotlib not installed — skipping graph)')
    except Exception as e:
        print(f'(graph failed: {e})')


if __name__ == '__main__':
    main()
