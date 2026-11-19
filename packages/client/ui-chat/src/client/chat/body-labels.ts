/**
 * Copy for the seat-less assistant body (`renderAssistantBody`).
 *
 * The body is rendered by an entry that owns the `assistant-step` seat without
 * the Chat view's locale seat, so it carries the few strings Chat's Markdown
 * chrome and interrupted marker need. Keep these identical to the shipped chat
 * locale dictionaries; a missing language falls back to English.
 */

/** Per-language body copy, keyed by the page language. */
export const BODY_LABELS: Record<string, Record<string, string>> = {
  en: {
    copy: 'Copy',
    copied: 'Copied',
    'codeBlock.title': 'Code block',
    'codeBlock.wrap': 'Wrap lines',
    'codeBlock.unwrap': 'Do not wrap lines',
    'markdown.footnotes': 'Footnotes',
    'number.thousand': '{value}K',
    'number.million': '{value}M',
    'message.stopped': 'Stopped',
  },
  zh: {
    copy: '复制',
    copied: '复制成功',
    'codeBlock.title': '代码块',
    'codeBlock.wrap': '自动换行',
    'codeBlock.unwrap': '取消自动换行',
    'markdown.footnotes': '脚注',
    'number.thousand': '{value}K',
    'number.million': '{value}M',
    'message.stopped': '已停止',
  },
  de: {
    copy: 'Kopieren',
    copied: 'Kopiert',
    'codeBlock.title': 'Codeblock',
    'codeBlock.wrap': 'Zeilen umbrechen',
    'codeBlock.unwrap': 'Zeilen nicht umbrechen',
    'markdown.footnotes': 'Fußnoten',
    'number.thousand': '{value}K',
    'number.million': '{value}M',
    'message.stopped': 'Gestoppt',
  },
  es: {
    copy: 'Copiar',
    copied: 'Copiado',
    'codeBlock.title': 'Bloque de código',
    'codeBlock.wrap': 'Ajustar líneas',
    'codeBlock.unwrap': 'No ajustar líneas',
    'markdown.footnotes': 'Notas a pie de página',
    'number.thousand': '{value}K',
    'number.million': '{value}M',
    'message.stopped': 'Detenido',
  },
  fr: {
    copy: 'Copier',
    copied: 'Copié',
    'codeBlock.title': 'Bloc de code',
    'codeBlock.wrap': 'Activer le retour à la ligne',
    'codeBlock.unwrap': 'Désactiver le retour à la ligne',
    'markdown.footnotes': 'Notes de bas de page',
    'number.thousand': '{value}K',
    'number.million': '{value}M',
    'message.stopped': 'Arrêté',
  },
  ja: {
    copy: 'コピー',
    copied: 'コピーしました',
    'codeBlock.title': 'コードブロック',
    'codeBlock.wrap': '行を折り返す',
    'codeBlock.unwrap': '行を折り返さない',
    'markdown.footnotes': '脚注',
    'number.thousand': '{value}K',
    'number.million': '{value}M',
    'message.stopped': '停止しました',
  },
  pt: {
    copy: 'Copiar',
    copied: 'Copiado',
    'codeBlock.title': 'Bloco de código',
    'codeBlock.wrap': 'Quebrar linhas',
    'codeBlock.unwrap': 'Não quebrar linhas',
    'markdown.footnotes': 'Notas de rodapé',
    'number.thousand': '{value}K',
    'number.million': '{value}M',
    'message.stopped': 'Interrompido',
  },
  ru: {
    copy: 'Копировать',
    copied: 'Скопировано',
    'codeBlock.title': 'Блок кода',
    'codeBlock.wrap': 'Переносить строки',
    'codeBlock.unwrap': 'Не переносить строки',
    'markdown.footnotes': 'Сноски',
    'number.thousand': '{value}K',
    'number.million': '{value}M',
    'message.stopped': 'Остановлено',
  },
}
