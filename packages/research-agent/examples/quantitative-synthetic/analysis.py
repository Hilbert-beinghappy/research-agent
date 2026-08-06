import csv
import json
import os

with open(os.environ["PI_RESEARCH_INPUT_0"], encoding="utf-8", newline="") as source:
    rows = list(csv.DictReader(source))

groups = {"0": [], "1": []}
for row in rows:
    groups[row["explanation_visible"]].append(float(row["trust_score"]))

result = {
    "mean_trust_by_explanation": {
        key: round(sum(values) / len(values), 6) for key, values in sorted(groups.items())
    },
    "n": len(rows),
    "seed": int(os.environ["PI_RESEARCH_SEED"]),
}
output_directory = os.environ["PI_RESEARCH_OUTPUT_DIR"]
with open(os.path.join(output_directory, "result.json"), "w", encoding="utf-8") as output:
    json.dump(result, output, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    output.write("\n")
with open(os.path.join(output_directory, "analysis-status.json"), "w", encoding="utf-8") as status:
    status.write('{"status":"succeeded"}\n')
