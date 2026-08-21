import { assert } from "chai";
import { mapSourceRangeToTarget } from "../src/modules/annotationMapping.ts";

describe("annotation sentence mapping", function () {
  it("keeps the However annotation on the matching Chinese sentence", function () {
    const source =
      "Root Cause Analysis for service systems is critical for ensuring their reliability, while its application remains challenging because of the large number of metrics and the complex causal relationships. " +
      "Classical RCA methods typically rely on statistical or rule-based approaches, making them difficult to generalize to unseen systems. " +
      "The introduction of Large Language Models has partly addressed these challenges with their understanding of domain-specific semantics. " +
      "However, they still struggle with incomplete or shallow reasoning when facing a large amount of metrics. " +
      "To address these limitations, we present FoundRoot.";
    const target =
      "服务系统的根本原因分析对于确保其可靠性至关重要，但其应用仍然具有挑战性。" +
      "经典RCA方法通常依赖统计或基于规则的方法，使其难以泛化到未见过的系统。" +
      "大语言模型的引入凭借其对领域特定语义的理解，部分解决了这些挑战。" +
      "然而，在面对大量指标时，它们仍然存在推理不完整或浅层的问题。" +
      "为解决这些局限性，我们提出了FoundRoot。";
    const sourceStart = source.indexOf("However");
    const sourceEnd = source.indexOf("To address") - 1;

    const [targetStart, targetEnd] = mapSourceRangeToTarget(
      source,
      target,
      sourceStart,
      sourceEnd,
    );
    const mapped = target.slice(targetStart, targetEnd);

    assert.match(mapped, /^然而/u);
    assert.include(mapped, "浅层的问题");
    assert.notInclude(mapped, "为解决这些局限性");
  });

  it("keeps equal-count sentence mappings index aligned", function () {
    const source = `${"A".repeat(160)}. ${"B".repeat(120)}. However sentence. Next sentence.`;
    const target = "甲。乙。然而句。下一句。";
    const sourceStart = source.indexOf("However");
    const sourceEnd = sourceStart + "However sentence.".length;

    const [targetStart, targetEnd] = mapSourceRangeToTarget(
      source,
      target,
      sourceStart,
      sourceEnd,
    );

    assert.equal(target.slice(targetStart, targetEnd), "然而句。");
  });
});
