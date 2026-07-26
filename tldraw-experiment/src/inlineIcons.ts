import spriteRaw from '@tldraw/assets/icons/icon/0_merged.svg?raw'

// Chromium can't resolve #fragment targets inside a data-URI SVG sprite,
// so split the merged sprite into standalone per-icon data URIs.
export function getInlineIconUrls(): Record<string, string> {
	const doc = new DOMParser().parseFromString(spriteRaw, 'image/svg+xml')
	const icons: Record<string, string> = {}
	for (const el of Array.from(doc.documentElement.children)) {
		const id = el.getAttribute('id')
		if (!id) continue
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" fill="none">${el.outerHTML}</svg>`
		icons[id] = `data:image/svg+xml,${encodeURIComponent(svg)}`
	}
	return icons
}
