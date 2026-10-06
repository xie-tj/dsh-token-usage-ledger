// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { installUsageNavGlyph, USAGE_NAV_ROW_ATTRIBUTE } from '../src/client/usageNavGlyph.ts'

const GEAR = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2"/></svg>'
const OWN_GLYPH = '<svg data-usage-ledger-mark="nav" viewBox="0 0 16 16"><rect width="3" height="4"/></svg>'

function row(label: string, glyph = GEAR): string {
  return `<button type="button">${glyph}<span>${label}</span></button>`
}

function dialog(...rows: string[]): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute('role', 'dialog')
  element.innerHTML = `<nav>${rows.join('')}</nav>`
  document.body.append(element)
  return element
}

function ticks(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

afterEach(() => { document.body.innerHTML = '' })

describe('Usage nav glyph adapter', () => {
  it('tags only the row showing this plugin label and untags it on dispose', () => {
    const panel = dialog(row('通用设置'), row('用量'), row('插件市场'))
    const rows = [...panel.querySelectorAll('button')]

    const dispose = installUsageNavGlyph(() => '用量')
    expect(rows.map(item => item.hasAttribute(USAGE_NAV_ROW_ATTRIBUTE))).toEqual([false, true, false])

    dispose()
    expect(rows.some(item => item.hasAttribute(USAGE_NAV_ROW_ATTRIBUTE))).toBe(false)
  })

  it('tags a settings panel opened after install', async () => {
    const dispose = installUsageNavGlyph(() => '用量')
    const panel = dialog(row('用量'))
    const usageRow = panel.querySelector('button')

    await ticks()
    expect(usageRow?.hasAttribute(USAGE_NAV_ROW_ATTRIBUTE)).toBe(true)
    dispose()
  })

  it('leaves the row alone when the shell renders the plugin glyph itself', () => {
    const panel = dialog(row('通用设置'), row('用量', OWN_GLYPH))
    const usageRow = panel.querySelectorAll('button')[1]

    const dispose = installUsageNavGlyph(() => '用量')
    expect(usageRow.hasAttribute(USAGE_NAV_ROW_ATTRIBUTE)).toBe(false)
    dispose()
  })

  it('keeps the row tagged when a locale change replaces the label', async () => {
    const panel = dialog(row('用量'))
    const usageRow = panel.querySelector('button') as HTMLButtonElement
    let label = '用量'

    const dispose = installUsageNavGlyph(() => label)
    expect(usageRow.hasAttribute(USAGE_NAV_ROW_ATTRIBUTE)).toBe(true)

    label = 'Usage'
    ;(usageRow.querySelector('span') as HTMLSpanElement).textContent = 'Usage'
    usageRow.append(document.createElement('i'))
    await ticks()
    expect(usageRow.hasAttribute(USAGE_NAV_ROW_ATTRIBUTE)).toBe(true)
    dispose()
  })
})
