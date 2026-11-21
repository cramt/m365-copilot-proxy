import { EventEmitter } from 'node:events';
export const wire: { ending: string; transport: string; sockets: FakeSocket[] } = { ending: '', transport: '', sockets: [] };
const raw = 'x = [regex]::Replace(a)\n';
const stripped = 'x = :Replace(a)\nthen the rest';
const item = (v: object) => ({ type: 2, invocationId: '1', item: v });
const part = (argument: object) => item({ type: 'message_part', target: 'update', argument });
export default class FakeSocket extends EventEmitter {
  static OPEN = 1; readyState = 1; sent: string[] = []; started = false; closed = false;
  constructor(public url: string, _options: unknown) { super(); wire.sockets.push(this); setTimeout(() => { this.emit('open'); this.frame({}); }, 0); }
  frame(v: unknown) { this.emit('message', Buffer.from(JSON.stringify(v) + '\x1e')); }
  send(data: string) {
    this.sent.push(data);
    if (this.started || (!data.includes('"target":"chat"') && !data.includes('"type":"chat_request"'))) return;
    this.started = true;
    const frames = wire.transport === 'chathub' ? [
      {type:1,target:'update',arguments:[{messages:[{author:'bot',messageId:'m1',text:'x = '}]}]},
      {type:1,target:'update',arguments:[{writeAtCursor:'[regex]::Replace(a)\n'}]},
      {type:1,target:'update',arguments:[{messages:[{author:'bot',messageId:'m1',text:stripped}]}]},
    ] : [
      part({cursor:{j:"$['m1'].adaptiveCards[0].body[0].text",p:-1},messages:[{author:'bot',text:'',contentOrigin:'DeepLeo',messageId:'m1'}]}),
      part({w:raw}),
      part({cursor:{j:"$['m1'].adaptiveCards[0].body[0].text",p:-1},messages:[{author:'bot',text:'',contentOrigin:'DeepLeo',messageId:'m1'}]}),
      part({messages:[{author:'bot',text:stripped,contentOrigin:'DeepLeo',messageId:'m1'}],isLastUpdate:true}),
    ];
    frames.forEach((f,i) => setTimeout(() => this.frame(f), 10 + 10*i));
    const delay = 10 + 10*frames.length;
    setTimeout(() => {
      if (wire.ending === '3' || wire.ending === '7') this.frame({type:Number(wire.ending),invocationId:'0'});
      else if (wire.ending === 'request_end') this.frame(item({type:'request_end',outcome:{category:'Success'}}));
      else if (wire.ending === 'grace') this.frame(part({messages:[{author:null,messageType:'EndOfRequest',messageId:'e1'}]}));
      else if (wire.ending === 'close') { this.readyState=3; this.emit('close'); }
      else if (wire.ending === 'error') this.emit('error',new Error('synthetic reset'));
    },delay);
  }
  close() { this.closed=true; this.readyState=2; /* intentionally delayed close; transport never acknowledges */ }
  terminate() { this.closed=true; this.readyState=3; this.emit('close'); }
}
