import { languages, ColorInformation, Position, Range, Color, window, DecorationOptions } from 'vscode';
import { arrayEqual, rgb2Hex, hex2RGB, isDarkColor } from '../utils';
import { ClassParser } from 'windicss/utils/parser';
import { HTMLParser } from '../utils/parser';

import type Extension from './index';
import type { TextDocument, DocumentSelector, TextEditor, TextEditorDecorationType } from 'vscode';
import type { Processor } from 'windicss/lib';

type Decorator = { decoration: TextEditorDecorationType, option: DecorationOptions };

const CUBE = window.createTextEditorDecorationType({
  before: {
    width: '0.8em',
    height: '0.8em',
    contentText: ' ',
    border: '0.1em solid',
    margin: '0.1em 0.2em 0',
  },
  dark: {
    before: {
      borderColor: '#eeeeee',
    },
  },
  light: {
    before: {
      borderColor: '#000000',
    },
  },
});

// const BG = window.createTextEditorDecorationType({
//   backgroundColor: 'transparent',
//   color: 'black',
// });

// const BORDER = window.createTextEditorDecorationType({
//   borderWidth: '2px',
//   borderColor: 'transparent',
// });

export default class Decorations {
  extension: Extension;
  processor: Processor;
  decorations: TextEditorDecorationType[] = [];
  timeout?: NodeJS.Timer;
  constructor(extension: Extension, processor: Processor) {
    this.extension = extension;
    this.processor = processor;
  }

  provideColors(document: TextDocument, type: 'bg'| 'border'): Decorator[];
  provideColors(document: TextDocument, type: 'cube') : DecorationOptions[];
  provideColors(document: TextDocument, type: 'picker') : ColorInformation[];
  provideColors(document: TextDocument, type: 'cube' | 'bg' | 'border' | 'picker' = 'cube') {
    const colors = [];
    const provider = type === 'cube'? createColorCube : type === 'picker' ? createColorInfo : type === 'bg' ? createColorBg : createColorBorder;
    const documentText = document.getText();
    const parser = new HTMLParser(documentText);
    parser.removeComments();
    for (const attr of parser.parseAttrs()) {
      if (this.extension.isAttrUtility(attr.key)) {
        // insert decoration in bg|text|... = "..."
        const regex = /\S+/igm;
        const data = attr.value.raw;
        let match;
        while ((match = regex.exec(data as string))) {
          if (match) {
            let color;
            if (match[0] in this.extension.colors) {
              color = hex2RGB(this.extension.colors[match[0]] as string);
            } else if (match[0].startsWith('hex-')) {
              color = hex2RGB(match[0].replace(/^hex-/, '#'));
            }
            if (color) colors.push(provider(document, attr.value.start, match.index, match[0], color));
          }
        }
      } else if (['class', 'className'].includes(attr.key) || this.extension.isAttrVariant(attr.key)) {
        // insert decoration in class|className|sm|hover|... = "..."
        const elements = new ClassParser(attr.value.raw, this.processor.config('separator', ':') as string, Object.keys(this.extension.variants)).parse(false);
        for (const element of elements) {
          if (element.type === 'group' && Array.isArray(element.content)) {
            for (const e of element.content) {
              const color = this.extension.isValidColor(e.raw);
              if(color.color) colors.push(provider(document, attr.value.start, e.start, e.raw, color.color));
            }
          }
          const color = element.type === 'utility' && this.extension.isValidColor(element.raw);
          if(color && color.color) colors.push(provider(document, attr.value.start, element.start, element.raw, color.color));
        }
      }
    }

    // insert decoration in @apply ...
    for (const className of parser.parseApplies()) {
      const elements = new ClassParser(className.result, this.processor.config('separator', ':') as string, Object.keys(this.extension.variants)).parse(false);
      for (const element of elements) {
        if (element.type === 'group' && Array.isArray(element.content)) {
          for (const e of element.content) {
            const color = this.extension.isValidColor(e.raw);
            if(color && color.color) colors.push(provider(document, className.start, e.start, e.raw, color.color));
          }
        }
        const color = element.type === 'utility' && this.extension.isValidColor(element.raw);
        if(color && color.color) colors.push(provider(document, className.start, element.start, element.raw, color.color));
      }
    }

    return colors;
  }

  registerColorPicker(ext: DocumentSelector) {
    return languages.registerColorProvider(ext, {
      // insert color before class
      provideDocumentColors: (document) => this.provideColors(document, 'picker'),

      provideColorPresentations: (color, context) => {
        const editor = window.activeTextEditor;

        if (editor) {
          const document = editor.document;
          const range = context.document.getWordRangeAtPosition(context.range.end, /[@<:-\w]+/) as Range;
          const utility = document.getText(range);
          const vcolor = this.extension.isValidColor(utility);
          if (!arrayEqual(vcolor.color as number[], [color.red * 255, color.green * 255, color.blue * 255]) && range) {
            const vrange = new Range(new Position(range.start.line, range.start.character + utility.indexOf(vcolor.key as string)), range.end);
            editor.edit(editBuilder => {
              editBuilder.replace(vrange, `hex-${rgb2Hex(color.red, color.green, color.blue).slice(1,)}`);
            });
          }
        }

        return [];
      },
    });
  }

  registerColorBlock(editor: TextEditor, type: 'bg' | 'border' | 'cube' = 'cube') {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    this.timeout = setTimeout(() => {
      if (type === 'cube') {
        const colors = this.provideColors(editor.document, type);
        editor.setDecorations(CUBE, colors);
      } else {
        this.decorations.map(i => i.dispose());
        const colors = this.provideColors(editor.document, type);
        colors.forEach(({ decoration, option }) => {
          this.decorations.push(decoration);
          editor.setDecorations(decoration, [ option ]);
        });
      }
    }, 200);
  }
}

function createColorInfo(document: TextDocument, start: number, offset: number, raw: string, color: number[]): ColorInformation {
  return new ColorInformation(new Range(document.positionAt(start + offset), document.positionAt(start + offset + 1)), new Color(color[0]/255, color[1]/255, color[2]/255, 1));
}

function createColorCube(document: TextDocument, start: number, offset: number, raw: string, color: number[]): DecorationOptions {
  return { range: new Range(document.positionAt(start + offset), document.positionAt(start + offset + raw.length)), renderOptions: { before: {	backgroundColor: `rgba(${color.join(', ')}, 1)` } } };
}

function createColorBorder(document: TextDocument, start: number, offset: number, raw: string, color: number[]): Decorator {
  const decoration = window.createTextEditorDecorationType({
    borderColor: `rgba(${color.join(', ')}, 1)`,
    borderStyle: 'solid',
    borderWidth: '1px',
  });
  return { decoration, option: { range: new Range(document.positionAt(start + offset), document.positionAt(start + offset + raw.length)) } };
}

function createColorBg(document: TextDocument, start: number, offset: number, raw: string, color: number[]): Decorator {
  const decoration = window.createTextEditorDecorationType({
    backgroundColor: `rgba(${color.join(', ')}, 1)`,
    color: isDarkColor(color[0], color[1], color[2]) ? '#eeeeee' : '#000000',
  });
  return { decoration, option: { range: new Range(document.positionAt(start + offset), document.positionAt(start + offset + raw.length)) } };
}
