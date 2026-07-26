import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite'
import { useRef } from 'react'
import { Tldraw, createShapeId, type Editor, type TLShapePartial } from 'tldraw'

import { getInlineIconUrls } from './inlineIcons'

const baseAssetUrls = getAssetUrlsByImport()
const assetUrls = { ...baseAssetUrls, icons: { ...baseAssetUrls.icons, ...getInlineIconUrls() } }

// 🌳 Fractal tree
function drawFractalTree(editor: Editor) {
	const shapes: TLShapePartial[] = []

	function branch(x: number, y: number, len: number, angle: number, depth: number) {
		const thick = Math.max(1, depth * 1.6)
		shapes.push({
			id: createShapeId(),
			type: 'geo',
			x,
			y,
			rotation: angle,
			props: {
				geo: 'rectangle',
				w: len,
				h: thick,
				color: depth > 1 ? 'grey' : 'green',
				fill: 'solid',
			},
		})

		const x2 = x + Math.cos(angle) * len
		const y2 = y + Math.sin(angle) * len

		if (depth === 0) {
			// leaf
			shapes.push({
				id: createShapeId(),
				type: 'geo',
				x: x2 - 6,
				y: y2 - 6,
				props: { geo: 'ellipse', w: 12, h: 12, color: 'light-green', fill: 'solid' },
			})
			return
		}
		const wobble = () => 0.35 + Math.random() * 0.25
		branch(x2, y2, len * 0.72, angle - wobble(), depth - 1)
		branch(x2, y2, len * 0.72, angle + wobble(), depth - 1)
	}

	branch(0, 0, 140, -Math.PI / 2, 9) // start trunk pointing up

	editor.createShapes(shapes)
	editor.zoomToFit()
}

function App() {
	const editorRef = useRef<Editor | null>(null)

	return (
		<div style={{ position: 'fixed', inset: 0 }}>
			<Tldraw
				assetUrls={assetUrls}
				onMount={(editor) => {
					editorRef.current = editor
				}}
			/>
			<button
				style={{
					position: 'absolute',
					top: 8,
					left: 8,
					zIndex: 1000,
					padding: '6px 12px',
					borderRadius: 6,
					border: '1px solid #ccc',
					background: 'white',
					cursor: 'pointer',
				}}
				onClick={() => {
					if (editorRef.current) drawFractalTree(editorRef.current)
				}}
			>
				🌳 Draw Fractal Tree
			</button>
		</div>
	)
}

export default App
