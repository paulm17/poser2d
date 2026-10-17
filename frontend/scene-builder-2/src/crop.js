// The opposite corner stays anchored; width and height are independent.
export function resizeCrop(rect, corner, dx, dy, bounds, minimum = 8) {
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  let left = rect.x, top = rect.y, right = rect.x + rect.width, bottom = rect.y + rect.height;
  if (corner.includes('w')) left = clamp(left + dx, bounds.left, right - minimum);
  else right = clamp(right + dx, left + minimum, bounds.right);
  if (corner.includes('n')) top = clamp(top + dy, bounds.top, bottom - minimum);
  else bottom = clamp(bottom + dy, top + minimum, bounds.bottom);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
