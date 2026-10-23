import type { BlockOut } from '../api';

type Point = { clientX: number; clientY: number };
type Caret = { node: Text; offset: number; span: HTMLElement };

function textSpans(page: HTMLElement): HTMLElement[] {
  return Array.from(page.querySelectorAll<HTMLElement>('.textLayer span'))
    .filter(span => span.firstChild?.nodeType === Node.TEXT_NODE && !!span.textContent?.trim() && span.getAttribute('role') !== 'img');
}

/** PDF object order can alternate columns; give native ranges a coherent block order. */
export function orderTextLayer(host: HTMLElement, blocks: BlockOut[]) {
  const page = host.closest<HTMLElement>('[data-pdf-page]');
  if (!page || !blocks.length) return;
  const origin = page.getBoundingClientRect();
  const width=host.offsetWidth || page.offsetWidth;
  const scale = origin.width / width;
  const spans = textSpans(host);
  const ordered = spans.map((span, index) => {
    const rect = span.getBoundingClientRect();
    const box = [(rect.left-origin.left)/scale, (rect.top-origin.top)/scale,
                 (rect.right-origin.left)/scale, (rect.bottom-origin.top)/scale];
    const hits = blocks.map(block => ({block, overlap: Math.max(0, Math.min(box[2],block.bbox[2])-Math.max(box[0],block.bbox[0])) *
      Math.max(0, Math.min(box[3],block.bbox[3])-Math.max(box[1],block.bbox[1]))})).filter(hit=>hit.overlap>(box[2]-box[0])*(box[3]-box[1])*.5);
    hits.sort((a,b)=>b.overlap-a.overlap);
    const block = hits[0]?.block;
    if (block) span.dataset.pdfBlock = String(block.id);
    return {span, index, box, block, order: block?.reading_order ?? Number.MAX_SAFE_INTEGER, column:'full', band:0};
  });
  // Infer columns from the actual selectable text, even when a layout model misses a block.
  let gutter: number | null=null, best=Infinity;
  const total=ordered.reduce((sum,item)=>sum+(item.span.textContent?.length || 0),0);
  if (!blocks.some(block=>block.metadata?.rotation) && ordered.length>=6) {
    for(let x=width*.32;x<=width*.68;x+=width*.01) {
      let left=0,right=0,cross=0;
      for(const item of ordered) {
        const weight=item.span.textContent?.length || 0;
        if(item.box[2]<=x) left+=weight;else if(item.box[0]>=x) right+=weight;else cross+=weight;
      }
      if(left<total*.2 || right<total*.2) continue;
      const score=cross/total+Math.abs(x-width/2)/width*.001;
      if(score<best && cross/total<=.2) {best=score;gutter=x;}
    }
  }
  if(gutter!==null) {
    for(const item of ordered) item.column=item.block?.block_type==='heading' ? 'full' : item.box[2]<=gutter ? 'left' : item.box[0]>=gutter ? 'right' : 'full';
    const dividers=ordered.filter(item=>item.column==='full');
    for(const item of ordered) {
      item.band=dividers.filter(divider=>divider.box[3]<=item.box[1]+1).length;
      item.span.dataset.pdfColumn=item.column;
      item.span.dataset.pdfBand=String(item.band);
    }
  }
  const columnRank=(column:string)=>column==='left' ? 0 : column==='right' ? 1 : 2;
  const rotated=blocks.some(block=>block.metadata?.rotation);
  ordered.sort((a,b)=>rotated ? a.order-b.order || a.index-b.index :
    a.band-b.band || columnRank(a.column)-columnRank(b.column) ||
    (Math.abs(a.box[1]-b.box[1])>Math.min(a.box[3]-a.box[1],b.box[3]-b.box[1])*.5 ? a.box[1]-b.box[1] : a.index-b.index));
  const fragment = document.createDocumentFragment();
  for (let i=0;i<ordered.length;i++) {
    const item = ordered[i];
    const next = ordered[i+1];
    const a = item.span.getBoundingClientRect(), b = next?.span.getBoundingClientRect();
    fragment.append(item.span);
    if (next && (item.column!==next.column || item.band!==next.band || b && Math.abs(a.top-b.top)>Math.min(a.height,b.height)*.5)) fragment.append(document.createElement('br'));
  }
  host.replaceChildren(fragment);
}

function closestCaret(spans: HTMLElement[], point: Point): Caret | null {
  let best: HTMLElement | null = null, distance=Infinity;
  const candidates=spans.map(span=>{
    const rect = span.getBoundingClientRect();
    const vertical=rect.height>rect.width*2 && (span.textContent?.length || 0)>1;
    return {span,rect,vertical,axis:vertical ? Math.abs(point.clientX-(rect.left+rect.right)/2) : Math.abs(point.clientY-(rect.top+rect.bottom)/2)};
  });
  const nearest=Math.min(...candidates.map(item=>item.axis));
  for(const {span,rect,vertical,axis} of candidates) {
    if(axis>nearest+Math.min(3,(vertical?rect.width:rect.height)*.25)) continue;
    const across=vertical ? Math.max(rect.top-point.clientY,0,point.clientY-rect.bottom) : Math.max(rect.left-point.clientX,0,point.clientX-rect.right);
    const score=across*across+axis*axis;
    if (score < distance) { distance=score; best=span; }
  }
  if (!best) return null;
  const node = best.firstChild as Text;
  const offsets = [0];
  for (const character of Array.from(node.data)) offsets.push(offsets[offsets.length-1]+character.length);
  const range = document.createRange();
  const center = (index: number) => {
    range.setStart(node,offsets[index]); range.setEnd(node,offsets[index+1]);
    const rect = range.getBoundingClientRect();
    return {x: (rect.left+rect.right)/2, y: (rect.top+rect.bottom)/2};
  };
  const first=center(0), last=center(offsets.length-2);
  let dx=last.x-first.x, dy=last.y-first.y;
  if (Math.abs(dx)+Math.abs(dy)<.01) { dx=1; dy=0; }
  const project = (x: number,y: number) => (x-first.x)*dx+(y-first.y)*dy;
  const target=project(point.clientX,point.clientY);
  let left=0, right=offsets.length-1;
  while (left<right) {
    const mid=Math.floor((left+right)/2), c=center(mid);
    if (target<project(c.x,c.y)) right=mid; else left=mid+1;
  }
  return {node,offset:offsets[left],span:best};
}

/** Precise endpoints in line gaps; constrain a two-column drag to its starting column. */
export function beginTextDrag(page: HTMLElement, event: MouseEvent, blocks: BlockOut[], onFinish: (point: Point, dragged: boolean) => void, startPoint: Point = event): (()=>void) | null {
  if (event.button!==0 || event.detail<1 || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return null;
  if ((event.target as HTMLElement).closest('button,input,textarea,a,[contenteditable="true"]')) return null;
  let spans=textSpans(page);
  const anchor=closestCaret(spans,startPoint);
  if (!anchor) return null;
  const startBox=anchor.span.getBoundingClientRect();
  if (startPoint.clientX < startBox.left-8 || startPoint.clientX > startBox.right+8 || startPoint.clientY < startBox.top-8 || startPoint.clientY > startBox.bottom+8) return null;
  const block=blocks.find(b=>String(b.id)===anchor.span.dataset.pdfBlock);
  if(event.detail>=2) {
    event.preventDefault();
    const range=document.createRange();
    if(event.detail===2) {
      type Segmenter = {segment(text:string): Iterable<{index:number;segment:string;isWordLike?:boolean}>};
      const WordSegmenter=(Intl as typeof Intl & {Segmenter?: new(locale:undefined,options:{granularity:'word'})=>Segmenter}).Segmenter;
      const words=WordSegmenter ? Array.from(new WordSegmenter(undefined,{granularity:'word'}).segment(anchor.node.data)).filter(word=>word.isWordLike) :
        Array.from(anchor.node.data.matchAll(/[\p{L}\p{N}\p{M}_'’-]+/gu)).map(word=>({index:word.index!,segment:word[0]}));
      const word=words.find(word=>word.index<=anchor.offset && word.index+word.segment.length>=anchor.offset);
      if(!word) return null;
      range.setStart(anchor.node,word.index);range.setEnd(anchor.node,word.index+word.segment.length);
    } else {
      const group=block ? spans.filter(span=>span.dataset.pdfBlock===String(block.id)) : [anchor.span];
      range.setStart(group[0].firstChild!,0);range.setEnd(group[group.length-1].firstChild!,group[group.length-1].textContent!.length);
    }
    const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);
    onFinish(event,true);return null;
  }
  const nativeWidth=page.querySelector<HTMLElement>('.textLayer')?.offsetWidth || page.offsetWidth;
  const column=anchor.span.dataset.pdfColumn;
  if(column==='left' || column==='right') {
    spans=spans.filter(span=>span.dataset.pdfColumn===column && span.dataset.pdfBand===anchor.span.dataset.pdfBand);
  } else if (block && !block.metadata?.rotation && block.bbox[2]-block.bbox[0] < nativeWidth*.6 && !['heading','image','table'].includes(block.block_type)) {
    const opposite=blocks.find(b=>b.id!==block.id && b.bbox[2]-b.bbox[0]>nativeWidth*.18 &&
      b.bbox[2]-b.bbox[0]<nativeWidth*.6 && b.bbox[1]<block.bbox[3] && b.bbox[3]>block.bbox[1] &&
      (b.bbox[0]>block.bbox[2]+8 || b.bbox[2]<block.bbox[0]-8));
    if (opposite) {
      const isLeft=block.bbox[0]<opposite.bbox[0];
      const gutter=isLeft ? (block.bbox[2]+opposite.bbox[0])/2 : (opposite.bbox[2]+block.bbox[0])/2;
      const origin=page.getBoundingClientRect(), scale=origin.width/nativeWidth;
      spans=spans.filter(span=>{ const rect=span.getBoundingClientRect();return isLeft ? (rect.left+rect.right)/2<origin.left+gutter*scale : (rect.left+rect.right)/2>origin.left+gutter*scale; });
    }
  }
  event.preventDefault();
  const selection=window.getSelection();
  selection?.setBaseAndExtent(anchor.node,anchor.offset,anchor.node,anchor.offset);
  let dragged=false, last: Point=startPoint, frame=0;
  const scroll=page.closest<HTMLElement>('.overflow-auto');
  const update=(point: Point) => {
    const focus=closestCaret(spans,point);
    if (focus) selection?.setBaseAndExtent(anchor.node,anchor.offset,focus.node,focus.offset);
  };
  const autoScroll=() => {
    frame=0;
    if (!dragged || !scroll) return;
    const rect=scroll.getBoundingClientRect();
    const delta=last.clientY<rect.top+24 ? -10 : last.clientY>rect.bottom-24 ? 10 : 0;
    if (delta) { scroll.scrollTop+=delta; update(last); frame=requestAnimationFrame(autoScroll); }
  };
  const move=(e: MouseEvent) => {
    last=e;
    if (!dragged && Math.hypot(e.clientX-startPoint.clientX,e.clientY-startPoint.clientY)<3) return;
    dragged=true; e.preventDefault();update(e);
    if (!frame) frame=requestAnimationFrame(autoScroll);
  };
  const cleanup=() => {
    document.removeEventListener('pointermove',move);
    document.removeEventListener('pointerup',up);
    window.removeEventListener('blur',cleanup);
    if (frame) cancelAnimationFrame(frame);
  };
  const up=(e: MouseEvent) => {
    cleanup();
    if (dragged) update(e);
    onFinish(e,dragged);
  };
  document.addEventListener('pointermove',move);
  document.addEventListener('pointerup',up);
  window.addEventListener('blur',cleanup);
  return cleanup;
}

/** Text-only rectangles avoid BR/container boxes spanning blank space or other columns. */
export function selectionRects(page: HTMLElement, selection: Selection): DOMRect[] {
  const selected=selection.getRangeAt(0), rects: DOMRect[]=[];
  for (const span of textSpans(page)) {
    const node=span.firstChild as Text;
    if (!selected.intersectsNode(node)) continue;
    const start=selected.startContainer===node ? selected.startOffset : 0;
    const end=selected.endContainer===node ? selected.endOffset : node.length;
    if (end<=start) continue;
    const range=document.createRange();range.setStart(node,start);range.setEnd(node,end);
    rects.push(...Array.from(range.getClientRects()));
  }
  return rects;
}

export function selectionText(page: HTMLElement, selection: Selection): string {
  const selected=selection.getRangeAt(0);
  let text='', previous: DOMRect | null=null;
  for(const span of textSpans(page)) {
    const node=span.firstChild as Text;
    if(!selected.intersectsNode(node)) continue;
    const start=selected.startContainer===node ? selected.startOffset : 0;
    const end=selected.endContainer===node ? selected.endOffset : node.length;
    if(end<=start) continue;
    const part=node.data.slice(start,end);
    const range=document.createRange();range.setStart(node,start);range.setEnd(node,end);
    const rect=range.getBoundingClientRect();
    const newLine=previous && Math.abs(rect.top-previous.top)>Math.min(rect.height,previous.height)*.5;
    const gap=previous && rect.left-previous.right>Math.min(rect.height,previous.height)*.15;
    const cjkJoin=/[\u3400-\u9fff]$/.test(text) && /^[\u3400-\u9fff]/.test(part);
    if(text && (newLine || gap) && !/\s$/.test(text) && !/^\s/.test(part) && !cjkJoin && !/-$/.test(text)) text+=' ';
    text+=part;previous=rect;
  }
  return text.replace(/\s+/g,' ').trim();
}
