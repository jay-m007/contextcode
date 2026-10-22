# Benchmarks

Each file is a set of questions about one open-source repository, with the files a developer would need to read to answer each question.

| File | Repository | Commit | Questions |
|---|---|---|---|
| `taxonomy.json` | shadcn-ui/taxonomy | `298a885` | 10 |
| `commerce.json` | vercel/commerce | `f7521d5` | 10 |
| `excalidraw.json` | excalidraw/excalidraw | `1d4dc2c` | 13 |
| `archguard.json` | jay-m007/archguard | `d412ef1` | 10 |

## How the answers were chosen

The questions and answer files were written by hand by the author, by reading each repository and checking with `grep` which files implement each feature. They were written before tuning, but the ranking was then tuned on the same set, so treat the numbers as indicative, not as a held-out result. More questions, especially from other people, would make the numbers more trustworthy.

## Running them

```bash
git clone https://github.com/vercel/commerce ../commerce
git -C ../commerce checkout f7521d57d29f0eb3d23c1399cf9bb299d61fcd21
node packages/cli/dist/index.js eval bench/commerce.json ../commerce --budget 8000
```

Add `--format json` for per-question ranks.
