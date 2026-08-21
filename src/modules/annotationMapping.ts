interface TextSegment {
  start: number;
  end: number;
}

export function splitTextSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const pattern = /[^.!?;。！？；]+[.!?;。！？；]*/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (end > start) segments.push({ start, end });
  }
  return segments.length ? segments : [{ start: 0, end: text.length }];
}

function getTargetSegmentRange(
  firstSourceIndex: number,
  lastSourceIndex: number,
  sourceCount: number,
  targetCount: number,
): [number, number] {
  if (sourceCount === targetCount) {
    return [firstSourceIndex, lastSourceIndex];
  }

  if (targetCount > sourceCount) {
    // A source sentence may have been split during translation. Allocate the
    // target sentences by ordered sentence boundaries so all of the split
    // pieces remain attached to their source sentence.
    const ratio = targetCount / Math.max(1, sourceCount);
    const first = Math.floor(firstSourceIndex * ratio);
    const last = Math.ceil((lastSourceIndex + 1) * ratio) - 1;
    return [
      Math.max(0, Math.min(targetCount - 1, first)),
      Math.max(0, Math.min(targetCount - 1, last)),
    ];
  }

  // Multiple source sentences may have been merged into one target sentence.
  // Map their ordinal midpoints into the smaller target sentence sequence.
  const ratio = targetCount / Math.max(1, sourceCount);
  const first = Math.floor((firstSourceIndex + 0.5) * ratio);
  const last = Math.floor((lastSourceIndex + 0.5) * ratio);
  return [
    Math.max(0, Math.min(targetCount - 1, first)),
    Math.max(0, Math.min(targetCount - 1, last)),
  ];
}

export function mapSourceRangeToTarget(
  source: string,
  target: string,
  sourceStart: number,
  sourceEnd: number,
): [number, number] {
  if (!source.length || !target.length) return [0, target.length];
  const sourceSegments = splitTextSegments(source);
  const targetSegments = splitTextSegments(target);
  let firstSourceIndex = sourceSegments.findIndex(
    (segment) => segment.end > sourceStart,
  );
  if (firstSourceIndex < 0) firstSourceIndex = sourceSegments.length - 1;
  let lastSourceIndex = sourceSegments.findIndex(
    (segment) => segment.end >= sourceEnd,
  );
  if (lastSourceIndex < 0) lastSourceIndex = sourceSegments.length - 1;

  // Translation changes character counts dramatically (especially English to
  // Chinese), so character-midpoint matching can move an annotation into the
  // next sentence. Sentence order is stable: use exact sentence indexes when
  // counts match, and an ordered merge/split fallback only when they do not.
  const [firstTargetIndex, lastTargetIndex] = getTargetSegmentRange(
    firstSourceIndex,
    lastSourceIndex,
    sourceSegments.length,
    targetSegments.length,
  );
  const firstSource = sourceSegments[firstSourceIndex];
  const lastSource = sourceSegments[lastSourceIndex];
  const firstTarget = targetSegments[firstTargetIndex];
  const lastTarget = targetSegments[lastTargetIndex];
  const startRatio =
    (sourceStart - firstSource.start) /
    Math.max(1, firstSource.end - firstSource.start);
  const endRatio =
    (sourceEnd - lastSource.start) /
    Math.max(1, lastSource.end - lastSource.start);
  const targetStart = Math.round(
    firstTarget.start +
      Math.max(0, Math.min(1, startRatio)) *
        (firstTarget.end - firstTarget.start),
  );
  const targetEnd = Math.round(
    lastTarget.start +
      Math.max(0, Math.min(1, endRatio)) * (lastTarget.end - lastTarget.start),
  );
  return [
    Math.max(0, Math.min(target.length - 1, targetStart)),
    Math.max(targetStart + 1, Math.min(target.length, targetEnd)),
  ];
}
