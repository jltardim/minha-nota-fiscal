# Certificado digital

Coloque aqui o certificado A1 da empresa (e-CNPJ), com o nome `empresa.pfx`.

- Este arquivo e tudo nesta pasta ficam **fora do Git** (veja o `.gitignore`). Nunca envie o certificado para ninguém.
- A senha **não** fica aqui: ela vai para o cofre do computador (Keychain no Mac, cofre do usuário no Windows,
  chaveiro no Linux) pelo comando `node ferramentas/nfse.mjs guardar-senha`.
- O certificado vence todo ano. Quando renovar, troque o arquivo e rode o `guardar-senha` de novo.
