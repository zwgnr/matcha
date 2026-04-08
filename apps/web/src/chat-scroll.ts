export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;

export interface ScrollPosition {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function getScrollContainerBottomScrollTop(position: ScrollPosition): number {
  const { clientHeight, scrollHeight } = position;
  if (![clientHeight, scrollHeight].every(Number.isFinite)) {
    return 0;
  }

  return Math.max(0, scrollHeight - clientHeight);
}

export function isScrollContainerNearBottom(
  position: ScrollPosition,
  thresholdPx = AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  const threshold = Number.isFinite(thresholdPx)
    ? Math.max(0, thresholdPx)
    : AUTO_SCROLL_BOTTOM_THRESHOLD_PX;

  const { scrollTop, clientHeight, scrollHeight } = position;
  if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) {
    return true;
  }

  const distanceFromBottom = getScrollContainerBottomScrollTop(position) - scrollTop;
  return distanceFromBottom <= threshold;
}
