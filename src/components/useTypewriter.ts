import { useEffect, useRef, useState } from 'react'

/**
 * Types `text` out character-group by character-group, but only when `animationKey` changes to a
 * new non-zero value. That gate is the whole point: the summary should animate on genuinely fresh
 * results and appear instantly on a refinement or a restored session, and the caller signals
 * which by whether it bumps the key.
 *
 * Returns the text to render and whether it has finished, so the caller can show a cursor.
 */
export function useTypewriter(text: string, animationKey: number, stepMs = 18, step = 3) {
  const [displayed, setDisplayed] = useState(text)
  const [done, setDone] = useState(true)
  const lastKey = useRef(0)

  useEffect(() => {
    if (!text) {
      setDisplayed('')
      setDone(true)
      return
    }
    if (animationKey <= 0 || animationKey === lastKey.current) {
      setDisplayed(text)
      setDone(true)
      return
    }
    lastKey.current = animationKey
    setDisplayed('')
    setDone(false)
    let i = 0
    const id = setInterval(() => {
      i = Math.min(i + step, text.length)
      setDisplayed(text.slice(0, i))
      if (i >= text.length) {
        clearInterval(id)
        setDone(true)
      }
    }, stepMs)
    return () => clearInterval(id)
  }, [text, animationKey, stepMs, step])

  return { displayed, done }
}
