git init --quiet --object-format=sha1 --initial-branch=main
git add --all
git commit --quiet --message files
record_commit=$(git rev-parse HEAD)
mkdir -p .astra/records results
for result in present stale absent; do
  cat > ".astra/records/$result.json" <<EOF
{
  "spec_version": "0.1.0",
  "address": "$result",
  "content_hash": "sha256:73cb3858a687a8494ca3323053016282f3dad39d42cf62ca4e79dda2aac7d9ac",
  "size": 2,
  "generated_by": {
    "commit": "$record_commit",
    "environment": {"iri": "urn:example:fixture"},
    "runner": {"id": "report-fixture", "version": "1"}
  }
}
EOF
done
mkdir -p .astra/records/alternate results/alternate
cat > .astra/records/alternate/pipeline.json <<EOF
{
  "spec_version": "0.1.0",
  "address": "pipeline#alternate",
  "content_hash": "sha256:73cb3858a687a8494ca3323053016282f3dad39d42cf62ca4e79dda2aac7d9ac",
  "size": 2,
  "generated_by": {
    "commit": "$record_commit",
    "inputs": [{"entry": "chosen", "content_hash": "sha256:73cb3858a687a8494ca3323053016282f3dad39d42cf62ca4e79dda2aac7d9ac", "size": 2}],
    "environment": {"iri": "urn:example:fixture"},
    "runner": {"id": "report-fixture", "version": "1"}
  }
}
EOF
printf 'x\n' > results/present.txt
printf 'x\n' > results/stale.txt
printf 'x\n' > results/alternate/pipeline.txt
git add --all
git commit --quiet --message records
sed 's/printf stale/printf revised/' astra.yaml > astra.new
mv astra.new astra.yaml
