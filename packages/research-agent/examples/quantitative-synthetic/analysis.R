data <- read.csv(Sys.getenv("PI_RESEARCH_INPUT_0"), stringsAsFactors = FALSE)
means <- tapply(data$trust_score, data$explanation_visible, mean)
seed <- as.integer(Sys.getenv("PI_RESEARCH_SEED"))
result <- sprintf(
  '{"mean_trust_by_explanation":{"0":%.6f,"1":%.6f},"n":%d,"seed":%d}',
  means[["0"]], means[["1"]], nrow(data), seed
)
output_directory <- Sys.getenv("PI_RESEARCH_OUTPUT_DIR")
writeLines(result, file.path(output_directory, "result.json"), useBytes = TRUE)
writeLines('{"status":"succeeded"}', file.path(output_directory, "analysis-status.json"), useBytes = TRUE)
