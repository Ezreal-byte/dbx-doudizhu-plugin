export interface Profile { id:string; nickname:string; character:number; music:number; sound:number; voice:number; lowMotion:boolean }
export interface RoomInfo { id:string; name:string; address:string; addresses?:string[]; count:number; locked:boolean; phase:string; initialBeans:number; protocol:number }
export interface PlayerView {id:string; nickname:string; character:number; seat:number; beans:number; ready:boolean; connected:boolean; trustee:boolean; isHost:boolean}
export interface Play {seat:number; cards:number[]; kind:string}
export interface GameView {roundId:string; phase:'bidding'|'doubling'|'playing'|'finished'; hand:number[]; bottom:number[]; turn:number; bids:number[]; doubles:number[]; landlord:number; lastPlay:Play|null; passes:number; remaining:number[]; deadline:number; multiplier:number; winner:number; settlement?:{deltas:number[]; balances:number[]; spring:boolean}; history?:Play[]}
export interface Snapshot {room:RoomInfo; selfId:string; hostId:string; players:PlayerView[]; game:GameView|null; revision:number; resetVotes:string[]; connection:string}
export interface SocialEvent {id:string; roomId:string; fromId:string; targetId:string; kind:string; phrase?:string; at:number}
export interface DbxBridge { ready:Promise<unknown>; invoke<T=unknown>(method:string,params?:unknown,options?:{timeoutMs:number}):Promise<T>; onEvent(callback:(e:{method:string;params:any})=>void):()=>void; readAsset(path:string):Promise<{contentType:string;dataBase64:string}>; readAssetUrl(path:string):Promise<string>; workbench?:{onClose(callback:()=>void|Promise<void>):()=>void}; copy?(text:string):Promise<void> }
declare global {interface Window {dbxPlugin?:DbxBridge}}
