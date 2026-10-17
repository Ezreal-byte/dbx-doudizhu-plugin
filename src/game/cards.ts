export function rank(card:number){return card>=52?card-36:Math.floor(card/4)+3;}
export function label(card:number){return card>=52?(card===52?'小王':'大王'):({11:'J',12:'Q',13:'K',14:'A',15:'2'}[rank(card)]??String(rank(card)));}
export function suit(card:number){return card>=52?'★':['♠','♥','♣','♦'][card%4];}
export function red(card:number){return card===53||(card<52&&(card%4===1||card%4===3));}
export function sortCards(cards:number[]){return [...cards].sort((a,b)=>rank(b)-rank(a)||b-a);}
