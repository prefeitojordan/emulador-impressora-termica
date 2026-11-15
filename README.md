# Emulador de Impressora Térmica (ESC/POS)

Mostra uma impressora térmica no canto inferior direito da tela, com o papel **subindo** enquanto imprime. Use para testar sistemas (PDV, delivery, NFC-e, comandas) sem gastar bobina.

## Download (Windows)

Baixe na página de [Releases](https://github.com/prefeitojordan/emulador-impressora-termica/releases/latest):

- **`EmuladorImpressoraTermica-x.y.z-instalador.exe`**: instala com atalho no menu Iniciar.
- **`EmuladorImpressoraTermica-x.y.z-portatil.exe`**: roda direto, sem instalar.

Os executáveis não têm assinatura digital, então o Windows SmartScreen pode mostrar "O Windows protegeu o computador". Clique em **Mais informações → Executar assim mesmo**.

## Como rodar a partir do código

```
npm install
npm start              (ou: iniciar.bat)
npm run dist           (gera os .exe em dist/)
```
O app fica sempre por cima das outras janelas e deixa os cliques passarem nas áreas vazias. Ele também coloca um ícone na bandeja do Windows: clique para mostrar ou ocultar a impressora e use o botão direito para abrir o menu.

## Como o seu sistema imprime nele

| Forma | Endereço | Uso |
|---|---|---|
| **TCP RAW / JetDirect** | `IP-da-máquina:9100` | Igual a uma impressora de rede: abre o socket, manda os bytes ESC/POS e fecha. Cada conexão é um job. Aceita várias conexões e mantém a conexão aberta. Timeout de ociosidade: 30 s. |
| **HTTP** | `POST http://localhost:9101/print` | Corpo = bytes ESC/POS crus (`application/octet-stream`), ou JSON `{"text":"..."}` (UTF-8, corta no final; `"cut":false` desativa) ou `{"base64":"..."}`. CORS liberado, então dá para chamar via `fetch` num sistema web. |
| **Status HTTP** | `GET http://localhost:9101/status` | JSON com online, papel, colunas e jobs. |
| **Impressora do Windows** | `exemplos/instalar-impressora-windows.ps1` (rode como Admin) | Cria a impressora "Impressora Termica Emulada" (driver Generic/Text Only, porta TCP 127.0.0.1:9100 RAW). Serve para sistemas que imprimem pelo nome da impressora no spooler. |

Por padrão as portas só aceitam conexões **deste PC** (`127.0.0.1`). Para imprimir de celulares, maquininhas ou outros PCs da rede, ligue no menu **Aceitar impressões de outros aparelhos da rede**. Na primeira vez o Windows Firewall pode pedir permissão. Portas, host e outras opções ficam no menu **Editar configuração** (`%APPDATA%\emulador-impressora-termica\config.json`); depois de editar, use **Recarregar**.

Teste rápido: `npm run teste` (ou `node exemplos/enviar-teste.js [host] [porta] [colunas]`).

## Papel

| Bobina | Pontos imprimíveis (203 dpi) | Fonte A (12×24) | Fonte B (9×17) |
|---|---|---|---|
| 80 mm (padrão) | 576 | 48 colunas | 64 colunas |
| 58 mm | 384 | 32 colunas | 42 colunas |

A largura do papel é escolhida no menu, e só uma fica ativa por vez, nas duas portas. O texto que passa da largura quebra a linha automaticamente.

## Codificação

O modo padrão é **Automático**. Se o sistema mandar `ESC t n`, o emulador usa essa página de código e mostra lixo se os bytes não forem dela, como uma impressora real faria. Sem `ESC t`, ele detecta UTF-8 e, se não for UTF-8, usa CP850. No menu dá para forçar CP850, CP860, CP437, Windows-1252 ou UTF-8.
`ESC t`: 0=CP437, 2=CP850, 3=CP860, 4=CP863, 5=CP865, 16=WPC1252, 17=CP866, 18=CP852, 19=CP858.

## Comandos suportados

- **Texto:** `LF`, `CR` (ignorado), `HT`, `FF` (corta), `ESC @`, `ESC !`, `ESC E`/`ESC G` (negrito), `ESC -` (sublinhado 1/2), `ESC a` (alinhamento), `ESC M` (fonte A/B), `GS !` (tamanho 1–8×), `GS B` (invertido), `ESC 2`/`ESC 3` (entrelinha), `ESC $`/`ESC \` (posição), `ESC t`.
- **Avanço:** `ESC d n`, `ESC J n`.
- **Corte:** `GS V` (0/1/48/49, 65/66 com avanço), `ESC i`, `ESC m`. O cupom aparece destacado com borda picotada.
- **Gaveta:** `ESC p`, `DLE DC4 1`. Mostra um aviso "Gaveta acionada". **Bip:** `ESC B`, `ESC ( A`.
- **QR Code:** `GS ( k` (modelo 2, tamanho, correção L/M/Q/H, store/print), `ESC Z`.
- **Código de barras:** `GS k` (formas A e B): UPC-A, UPC-E, EAN-13, EAN-8, CODE39, ITF, CODABAR, CODE93, CODE128 (`{A {B {C`), com `GS h`, `GS w`, `GS H`. Um código inválido aparece em vermelho no papel.
- **Imagens:** `GS v 0` (raster, inclusive com escala), `ESC *` (8/24 pontos), `GS ( L`/`GS 8 L` (fn 112 + fn 50), `GS *` + `GS /`.
- **Status (responde no mesmo socket TCP):** `DLE EOT n` → `0x12` (online, sem erro, com papel), `GS r n` → `0x00`, `GS I n` → ID (`_EMULADOR`).
- **Aceitos e ignorados:** logos NV (`FS p`, `FS q`, aparecem como aviso), PDF417 (aviso), modo página, caracteres definidos pelo usuário, kanji, ASB.

O modelo emulado é um ESC/POS genérico no padrão Epson (TM-T20/T88). As Elgin i7/i9, Bematech MP-4200 (modo ESC/POS) e similares usam o mesmo conjunto.

## Recursos do app

- Clique com o botão direito em um cupom para copiar o texto, copiar a imagem ou salvar como PNG.
- Role com a roda do mouse para ver cupons antigos (ficam os últimos 30).
- Botões na impressora: avançar papel, limpar, recolher o papel e abrir o menu (largura, zoom, velocidade, codificação, som, salvar jobs em `.bin` para depuração).

## Segurança

- Por padrão só este PC consegue imprimir. Se você liberar a rede, qualquer aparelho dela pode mandar impressões para a sua tela. Só libere em redes confiáveis.
- A API HTTP aceita chamadas de qualquer origem (CORS `*`) para que sistemas web consigam imprimir via `fetch`. Isso significa que um site aberto no navegador também consegue mandar um cupom para a tela. Ele só consegue exibir conteúdo: não lê arquivos e não executa nada.
- Jobs maiores que 4 MB são descartados.
- A opção "Salvar jobs recebidos" grava os bytes como chegaram em `%APPDATA%\emulador-impressora-termica\jobs`. Cupons reais podem ter CPF, nomes e valores, então não compartilhe esses arquivos.

## Limitações

Não há porta COM/serial nem USB simulada. Para COM, dá para usar um par virtual (com0com) com um redirecionador para TCP 9100.
