# Shared implementation contract

Public plugin identity: `io.dbx.doudizhu`, version `0.1.1`, publisher `ezreal-byte`, display name `田园斗地主`. LAN protocol 2 supports five characters. All players should use the same public release. Earlier `local.doudizhu` versions were local development builds with a separate plugin identity and data directory.
Module: `dbx-doudizhu-plugin/backend`. Card ids 0..51: rank = floor(id/4)+3 (3..15 where15=2); suits = id%4 (spade,heart,club,diamond); 52=small joker,53=big joker.

DBX invoke methods (no method prefix wrapper):
- `profile.get` -> Profile; `profile.save` {nickname,character,music,sound,voice,lowMotion} -> Profile
- `music.get` -> {name,mime,dataBase64}|null; `music.set` {name,mime,dataBase64} or {clear:true} -> same. Device-local only, never sent to other players; audio file maximum 4 MiB and atomic persistence in plugin data directory.
- `lobby.scan` {query?} -> {rooms:RoomInfo[],addresses:string[]}
- `room.create` {name,password,initialBeans} -> Snapshot
- `room.join` {address,roomId?,password?} -> Snapshot
- `room.snapshot` {} -> Snapshot|null; `room.ready` {ready:boolean} -> Snapshot
- `room.leave` {} -> {ok:true}; `room.reset` {agree:boolean} -> Snapshot
- `game.action` {actionId,expectedRevision?,expectedRoundId?,type:'bid'|'double'|'play'|'pass'|'trustee',score?:number,double?:boolean,cards?:number[],enabled?:boolean} -> Snapshot. Simultaneous double choices may use an older revision only when expectedRoundId matches the current round and that player has not yet decided during doubling; bid/play/pass retain strict revision checks.
- `game.hint` {} -> {candidates:number[][]}
- `social.send` {actionId,targetId,kind:'tea'|'flower'|'tomato'|'egg'|'like'|'phrase',phrase?} -> {ok:true}

Events: `room.state` Snapshot; `room.closed` {reason}; `social.event` SocialEvent; `connection.state` {status,message?}. DBX callback receives {method,params} (defensively allow event wrapper). Full personalized snapshots are cheap and emitted on every state change; periodic snapshot polling recovers dropped host events. Room revision monotonic. Social is ephemeral and never part of replay.

Profile {id:string,nickname:string,character:0|1|2|3|4,music:number,sound:number,voice:number,lowMotion:boolean}. Volumes 0..1. Characters: 阿禾, 小满, 福伯, 青竹, 长安.
RoomInfo {id,name,address,addresses?:string[],count:number,locked:boolean,phase:string,initialBeans:number,protocol:number}
PlayerView {id,nickname,character:number,seat:number,beans:number,ready:boolean,connected:boolean,trustee:boolean,isHost:boolean}
Snapshot {room:RoomInfo,selfId:string,hostId:string,players:PlayerView[],game:GameView|null,revision:number,resetVotes:string[],connection:string}
GameView {roundId:string,phase:'bidding'|'doubling'|'playing'|'finished',hand:number[],bottom:number[],turn:number,bids:number[],doubles:number[],landlord:number,lastPlay:{seat:number,cards:number[],kind:string}|null,passes:number,remaining:number[],deadline:number,multiplier:number,winner:number,settlement?:{deltas:number[],balances:number[],spring:boolean},history?:{seat:number,cards:number[],kind:string}[]}
SocialEvent {id,roomId,fromId,targetId,kind,phrase?,at:number}
All timestamps milliseconds since epoch. Sort hands descending rank then suit. Bottom hidden until landlord chosen. Connection values connected/reconnecting/disconnected.

The pure rules and state machine live in backend/internal/game. Networking, room membership and persistence live in backend/internal/app. Engine exposes a typed View compatible with GameView above. No UI coupling in engine. Room serializes all changes under its lock; engine does not need internal locking.

Vue manages forms and authoritative state through src/App.vue and src/client.ts. Pixi manages visuals through src/game/TableScene.ts:
`createTableScene(container:HTMLElement, callbacks:{onSelect:(cards:number[])=>void,onPlayer:(id:string)=>void,onCancel:()=>void}):Promise<TableScene>`;
`scene.update(snapshot:Snapshot,selected:number[],lowMotion:boolean):void`; `scene.social(event:SocialEvent):void`; `scene.destroy():void`; `scene.stats():{fps:number}`.
Scene canvas 1600x900 responsive; renders characters, own hand (x320..1280,y710..855), other seats near (170,330)/(1430,330), bottom cards center top, recent plays middle. Vue overlays HUD/actions in free space; action row y610..680, top HUD y0..90. On render init failure frontend must DOM fallback.
