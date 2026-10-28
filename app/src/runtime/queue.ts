/** 有界 FIFO；暂停时不启动新消费，满队列触发持久阻塞回调。 */
export class BoundedQueue<T> {
  private readonly pending: T[] = [];
  private busy = false;
  private paused = false;
  private stopped = false;
  private failed = false;
  private current: Promise<void> | undefined;
  readonly capacity: number;
  private readonly consumer: (item:T)=>Promise<void>;
  private readonly onFault: (reason:string)=>void;
  constructor(capacity: number, consumer: (item:T)=>Promise<void>, onFault: (reason:string)=>void) {
    this.capacity=capacity;this.consumer=consumer;this.onFault=onFault;
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('queue capacity 必须为正数');
  }
  get length():number {return this.pending.length;}
  get isIdle():boolean {return this.pending.length===0 && !this.busy;}
  get isPaused():boolean{return this.paused;}
  get isFaulted():boolean{return this.failed;}
  push(item:T):boolean {
    if (this.stopped || this.failed) return false;
    if (this.pending.length >= this.capacity) {
      this.fault('queue_overflow_requires_reconciliation');
      return false;
    }
    this.pending.push(item);
    this.kick();
    return true;
  }
  pause():void {this.paused = true;}
  resume():void {if (!this.stopped && !this.failed) {this.paused=false;this.kick();}}
  private fault(reason:string):void {
    if (this.failed) return;
    this.failed=true;this.paused=true;
    this.onFault(reason);
  }
  private kick():void {
    if (this.busy || this.paused || this.stopped || this.failed) return;
    const item=this.pending.shift();
    if (item===undefined) return;
    this.busy=true;
    this.current=Promise.resolve().then(()=>this.consumer(item)).catch(()=>this.fault('queue_consumer_failed'))
      .finally(()=>{this.busy=false;this.current=undefined;this.kick();});
  }
  async stop():Promise<void> {
    this.stopped=true;this.paused=true;
    await this.current?.catch(()=>undefined);
    this.pending.length=0; // T2 不允许将这些事件视为已经持久化；下次 T4 必须对账
  }
}
