# AlignView

AlignView is an interactive question-answering system for time-aligned video
streams. You ask a question about recorded events, it answers, and it shows you
the footage behind the answer: up to three synchronized cameras at each cited
moment, with per-camera match scores. You judge each camera (confirm, refine or
ignore), and those verdicts steer the next round of retrieval until you are
satisfied with the answer.

The system is built and evaluated on the CASTLE 2024 dataset: four days of
unscripted activity filmed by cameras worn by the participants and by five fixed
room cameras.

The accompanying paper, *AlignView: Interactive Evidence Verification for
Question Answering over Time-Aligned Video Streams*, is under review at the
HIMAS workshop at IUI 2027.

## How it works

| Stage | What happens |
|---|---|
| Preprocessing | Videos are cut into 30-second clips with 1 fps frames; transcripts are grouped into short windows. |
| Annotation | Qwen3-VL-8B-Instruct (served with vLLM) writes a caption, a scene graph and OCR for each clip, plus two-minute event summaries. |
| Indexing | OmniEmbed encodes transcripts, captions and summaries into Qdrant; two BM25 indexes cover the transcript and visual text. |
| Routing | Keyword lists pick a route (visual, speech, temporal or mixed) and detect mentioned days, people and rooms. |
| Retrieval | Lexical and dense rankings are merged with Reciprocal Rank Fusion, per source and then across sources. |
| Reranking and answering | Qwen3-VL rates candidate evidence bundles, and the best ones go to the answer generator. |
| Interface | A Dash web app shows the answer, the cited moments, the synchronized cameras and the review controls. |

## Setup

```bash
git clone https://github.com/yidakra/AlignView.git
cd AlignView

python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"          # core + tests
pip install -e ".[ui]"           # web interface
pip install -e ".[inference]"    # GPU inference (vLLM, OmniEmbed)
```

Python 3.10 or newer is required.

## Data

The CASTLE 2024 dataset is on Hugging Face (`CASTLE-Dataset/CASTLE2024`).
Download it and point `dataset.root` in `configs/base.yaml` at it. The expected
layout is:

```text
castle2024/
  main/day{1..4}/{camera}/
    video/{HH}.mp4
    transcript/{HH}.json
    metadata/{HH}.*.csv
  auxiliary/{heartrate,gaze,photo,thermal,video}/
```

The CASTLE challenge question sets are not public and are not part of this
repository. `alignview answer` and `alignview eval` read your own questions,
either as JSON or as a CSV with the columns `Question, Answer, Distractor 1,
Distractor 2, Distractor 3, Day` (see `src/alignview/eval/io.py`).

## Pipeline

```bash
# Clips, frames and transcript windows (CPU)
alignview preprocess --day 1

# Captions + OCR, then event summaries (GPU, needs a vLLM endpoint)
export VLLM_BASE_URL=http://localhost:8000/v1
alignview preprocess --caption --day 1
alignview preprocess --events --day 1

# Auxiliary modalities: photo, thermal, video (CPU)
alignview preprocess --aux

# Embeddings (GPU)
alignview embed --modality transcript --day 1
alignview embed --modality video --day 1

# Qdrant collection + BM25 indexes
alignview index --create-collection
alignview index --lexical-only     # rebuild only the BM25 indexes

# Answer and evaluate
alignview answer questions.csv --out predictions.json
alignview eval questions.csv predictions.json
```

Add `--config path/to/config.yaml` to any command to override settings; config
files are deep-merged on top of `configs/base.yaml`.

To check that everything is wired up without models or services:

```bash
python scripts/smoke_local.py
```

It uses an in-memory Qdrant, random embeddings and a stub LLM, and exits 0 when
all synthetic questions get a valid prediction.

## Interface

```bash
alignview ui                     # http://127.0.0.1:8050
```

Without a running index the interface uses an offline placeholder engine, so you
can try it with no models, Qdrant or vLLM. Evidence videos play from the public
YouTube mirror of CASTLE; the mapping is in
`src/alignview/ui/youtube_mirror.csv`. See
[`src/alignview/ui/README.md`](src/alignview/ui/README.md) for details.

## Running on an HPC cluster

The `scripts/slurm/` directory holds the SLURM jobs we used on the Snellius
supercomputer, and [docs/snellius.md](docs/snellius.md) walks through the full
setup: environment, dataset download, vLLM servers, the job chain and
incremental ingest with `--day N`. [docs/ingest_all_days.md](docs/ingest_all_days.md)
covers ingesting all four days with every camera, and
[docs/demo.md](docs/demo.md) covers running the live interface. Set your own
account and storage paths in `configs/snellius.yaml` before submitting jobs.

## Tests

```bash
pytest
```
