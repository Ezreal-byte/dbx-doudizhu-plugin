# 原创美术与音频

`public/assets/countryside.png` 与 `characters.png` 使用内置 imagegen 生成，未使用第三方游戏图包。生成后复制进入项目；原始图保持不变。

场景提示词：Original premium 2D countryside card-game environment, 16:9, warm afternoon, turquoise sky, cream clouds, sage and jade rolling hills, terracotta cottages left, windmill right, trees at edges, wheat and sunflowers, large quiet emerald lawn in center for a table overlay, rich hand-painted details, dimensional shading, no UI/no text/no logo/no characters.

角色提示词：Original premium layered transparent cutout atlas, three columns for cheerful male tea-house host in emerald waistcoat, young woman in coral jacket and teal skirt, jovial elderly gentleman in ochre vest and jade cap; four rows for detached head, headless armless body+legs, left arm, right arm; polished dimensional game art; exactly twelve separate parts, no lettering, no existing famous characters. 动作通过独立头/身/手臂关节与时间线实现，不将完整角色作为单张图片晃动。

图集未经破坏性切割；运行时按透明边界建立 Sprite 纹理。卡牌、桌面金边、礼物与粒子使用项目原创绘制代码。

开发迭代中新增 `public/assets/characters-extra.png`：青竹（青绿绣衣、玉簪的年轻女角色）、长安（靛蓝云纹衣、半束发的年轻男角色），已纳入公开首版 0.1.0。内置 imagegen 生成并以第二次背景提取处理保存真实透明 alpha，原图保留。图像为 1024×1536、2 列；角色头、无臂身体、左臂、右臂的分隔线为 0 / 377 / 950 / 1233 / 1536。

新增图集提示词：Production transparent 2D skeletal animation sprite atlas, two original Chinese countryside card-game characters, Qingzhu in jade/teal embroidered jacket and modest flowing skirt, Changan in indigo cloud-embroidered jacket and navy trousers, premium cute dimensional chibi rendering, expressive faces, warm soft studio lighting, clean alpha edges. Two columns and four isolated rows: head with neck tab, armless torso with legs, left arm, right arm. Complete rounded shoulder roots and five-finger hands, no text, no logos, no famous character likeness. Background extraction prompt: remove only background and halos to genuine alpha zero, preserve every sprite detail and position, no checkerboard, gradients or shadows.

动画运行时以衣服上真实肩点及肘部重叠区域建立关节，头部与眼睑共用头节点；不会以整张头像晃动代替角色动作。

新版背景音乐、角色语音、模型来源及本地音乐导入说明见 `AUDIO_SOURCES.md`。随包不含腾讯《欢乐斗地主》录音。
