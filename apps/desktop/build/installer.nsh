; Let paired tablets reach the booth on private networks only (setup page 4100, HTTPS 4443).
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall add rule name="Picture Me Please Booth" dir=in action=allow protocol=TCP localport=4100,4443 profile=private'
!macroend
!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Picture Me Please Booth"'
!macroend
