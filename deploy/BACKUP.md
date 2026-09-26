# Backup no RESAN

A rotina guarda os dados completos de `/app/data` (incluindo SQLite, WAL e SHM), o código, Dockerfile, compose, package-lock e `.env` em `/var/backups/gas-cost`. O arquivo `application.tar.gz` exclui `.git`, `node_modules` e `data` do projeto. Segredos e dados privados estão incluídos: diretório com modo 700 e arquivos com modo 600. Os arquivos não são criptografados.

O container para apenas durante a cópia dos dados e volta a iniciar antes da compactação final. Se uma cópia falhar, a rotina tenta reiniciá-lo e retorna erro; containers que já estavam parados permanecem parados. Não execute deploy/rsync durante o backup. A retenção remove apenas arquivos desta rotina com mais de 30 dias, depois de um novo backup bem-sucedido.

## Instalar (uma vez no RESAN, após rsync)

```bash
cd /opt/projetos/gas-cost
sudo install -m 644 deploy/gascost-backup.service /etc/systemd/system/gascost-backup.service
sudo install -m 644 deploy/gascost-backup.timer /etc/systemd/system/gascost-backup.timer
sudo systemctl daemon-reload
sudo systemctl start gascost-backup.service
sudo systemctl enable --now gascost-backup.timer
systemctl list-timers gascost-backup.timer
```

O agendamento roda todos os dias às 03h, em America/Sao_Paulo. Se o host estava desligado, executa a pendência ao voltar. Não depende do Codex. Nenhuma imagem ou container adicional é necessário. O usuário que pode editar o projeto tem acesso equivalente a administrar essa rotina; mantenha o diretório restrito aos administradores.

## Executar e verificar

```bash
sudo systemctl start gascost-backup.service
sudo journalctl -u gascost-backup.service -n 50 --no-pager
sudo ls -lh /var/backups/gas-cost
```

Para conferir a integridade de uma cópia, entre na pasta com acesso administrativo e execute `sha256sum -c NOME_DO_ARQUIVO.tar.gz.sha256`. O checksum detecta corrupção; não substitui um teste de restauração. Falhas aparecem no status da unidade e no journal; não há envio de e-mail configurado.

Para alterar a retenção ou o destino, use `sudo systemctl edit gascost-backup.service` e defina, por exemplo:

```ini
[Service]
Environment=RETENTION_DAYS=60
Environment=BACKUP_DIR=/var/backups/gas-cost
```

Mantenha também uma cópia fora do RESAN: as cópias locais não protegem contra perda do disco ou do host.

## Restaurar

1. Desative temporariamente o timer (`sudo systemctl stop gascost-backup.timer`) e aguarde qualquer execução de backup terminar.
2. Verifique o checksum e extraia a cópia para uma pasta vazia e privada. Ela contém `data/`, `application.tar.gz` e `manifest.txt`. Extraia `application.tar.gz` em outra pasta para recuperar a versão do código e o `.env` correspondentes.
3. Pare o container. Preserve o volume atual para poder voltar atrás. Crie um **novo volume Docker** e copie **todo o conteúdo de `data/`** nele, incluindo os arquivos WAL e SHM. Não misture arquivos de backups diferentes e não copie apenas os `.db`.
4. Ajuste o compose restaurado para usar esse novo volume no destino `/app/data`. O processo roda como `node` (UID/GID 1000); garanta que ele possa escrever no diretório e arquivos restaurados.
5. Reconstrua/inicie a aplicação com o código e configuração restaurados. Teste login, veículos e abastecimentos. Para verificar o SQLite, execute `PRAGMA integrity_check` em cada banco restaurado (resposta esperada: `ok`).
6. Confirme a restauração antes de remover qualquer volume antigo e reative o timer (`sudo systemctl start gascost-backup.timer`).

A restauração também volta usuários e autorizações ao estado do backup. Revogue conexões antigas no perfil se necessário. O backup não inclui a imagem Docker, configuração global do HAProxy, certificados ou configurações da Cloudflare; a reconstrução precisa das dependências indicadas no código restaurado.
