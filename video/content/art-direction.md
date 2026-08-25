# Direção de arte — Pitwall promo

Regras vinculantes para as cenas. Não são sugestões: cada uma corresponde a um erro conhecido que denuncia vídeo amador. 1920×1080, 30fps, ~78s ≈ 2340 frames.

## Ritmo

- 8 cenas, média 7-14s. **Um corte por cena** — a cena é um pensamento, não um carrossel.
- Transição típica **8-12 frames** (267-400ms). Corte seco: 0f. Nunca acima de 18f.
- **Hold obrigatório**: quando a cascata de texto termina, o frame congela **20-30f** antes do corte. É o que compra a sensação de caro; sem isso o vídeo lê como nervoso.
- A cena de diagramas (14s) é o plano longo e quase parado do meio — dá contraste para o final.

## Easing

| Uso                                 | Curva                                                                     | Duração   |
| ----------------------------------- | ------------------------------------------------------------------------- | --------- |
| Entrada de texto/elemento           | `cubic-bezier(0.05,0.7,0.1,1)` (emphasized-decel)                         | 400-600ms |
| Saída                               | `cubic-bezier(0.3,0,0.8,0.15)`                                            | 200-300ms |
| Camada já em tela que se move/morfa | `cubic-bezier(0.2,0,0,1)`                                                 | 500-700ms |
| Impacto/beat                        | spring `stiffness 400, damping 30, mass 1` (overshoot ~4%, uma oscilação) | —         |
| Opacidade e cor puras               | `linear`                                                                  | —         |

**Saída sempre mais rápida que a entrada. Nunca `ease-in`.**

## Tipografia cinética

- **Headline** (≤6 palavras): line-mask, `yPercent 110→0`, 600ms `expo.out`, stagger de linha 0.1s.
- **Label / mono / número**: por caractere, stagger 0.02s, `y 24→0` + opacity, cascata total <700ms.
- **Subtítulo**: por palavra, stagger 0.04s, com `blur(4px)→0`.
- **Saída nunca é a entrada ao contrário**: se entrou por máscara, sai por opacity + scale 1→0.98.
- Hierarquia por **escala e peso, não por cor**: display 96-140px/600 contra mono 13-15px/400 com `letter-spacing .08em` uppercase. Razão ≥ 6:1. Um único nível de destaque por frame.

## Transições (só estas cinco)

1. **Corte seco no beat** — default, ~70% dos cortes.
2. **Wipe por máscara** herdando a caixa do texto: a máscara que revelou é a que leva embora.
3. **Match cut de forma**: o cursor/retângulo persiste entre cenas e vira outro elemento.
4. **Scale-through + blur**: A escala 1→1.06 com blur 0→8px saindo; B entra 0.96→1 com blur 6→0. 12f.
5. **Whip lateral** com motion-blur direcional, 6-8f — **uma única vez no filme inteiro**.

## Profundidade sem 3D

- Três planos com parallax diferencial: fundo 0.2×, meio 0.6×, frente 1.0× do mesmo deslocamento.
- Escala diferencial: fundo 1.02→1.0 (lento); frente 0.98→1.0 (rápido).
- Blur seletivo 2-6px atrás — **um plano nítido por vez**.
- Superfície #0F0E15 sobre #08080B com borda 1px #282534 a 40% de opacidade. **A borda é o que cria camada, não sombra.**
- **Grão SVG sempre**: `feTurbulence`, opacity 3-5%, `mix-blend-mode: overlay`, por cima de tudo. Mata o banding — que aparece justamente em gradiente escuro animado — e é o que faz parecer filmado.

## Cor — regra 90/8/2

- 90% grayscale escuro · 8% texto `#F1F0F6` · **2% accent**.
- `#9D8CFF` **nunca em bloco grande**: traço de 1-2px, caractere isolado, cursor, ou glow radial a 15%.
- O accent aparece **no momento do valor** (o agente executa, o resultado chega) e **some no hold** — sai antes do corte, não junto com ele.
- `#7FD6F2` apenas uma ou duas vezes no filme inteiro, como contraponto. Nunca no mesmo frame que o roxo com peso igual.
- Texto sobre accent: nunca. Accent sobre preto: sempre.

## As cinco proibições

1. Nada de easing linear em posição/escala, e nada de `ease-in` em lugar nenhum. Linear só em opacidade, cor e loop constante.
2. Não animar tudo ao mesmo tempo: no máximo 2 propriedades por elemento, com stagger entre elementos. O texto principal assenta primeiro, o secundário 100-150ms depois.
3. A saída não é a entrada invertida. Entrada revela, saída dissolve.
4. Nenhuma cena corta no instante em que a animação termina. 20 frames parados.
5. Não mover sem motivo, e não animar `filter`/layout em massa. Só `transform` + `opacity` (+ blur pontual). Se a cena segura 60fps sem esforço, provavelmente está certa.

---

Fontes: Emil Kowalski (_Great Animations_, _The Easing Blueprint_), Material 3 motion tokens, GSAP SplitText guide, Codrops stagger reveal, CSS-Tricks grainy gradients, LWKS _Rhythm and Pace_, e o rebrand Hitch (Gabriel Queiroz) no Behance.
