#requires -Version 7.4
[CmdletBinding()]
param([string]$Source=(Join-Path $PSScriptRoot '../apps/desktop/installer-tools/Rc2ResourceWitness.cs'))
$ErrorActionPreference='Stop'
if(!$IsWindows){throw 'Native witness fixtures require Windows NTFS.'}
$sourceText=[IO.File]::ReadAllText((Get-Item -LiteralPath $Source).FullName)
$testSource=@'
namespace AgentForge.Upgrade
{
    public sealed partial class Rc2Witness
    {
        private static readonly byte[] FixtureAsset = Encoding.UTF8.GetBytes("one owned resource");
        private static readonly byte[] FixturePrior = Encoding.UTF8.GetBytes("known predecessor fixture");
        private static readonly byte[] FixtureCurrent = Encoding.UTF8.GetBytes("known successor fixture");
        private static string Hash(byte[] b) { return Convert.ToHexString(SHA256.HashData(b)).ToLowerInvariant(); }
        static partial void TestNativeCode(string stage, int error) { throw new InvalidOperationException("Witness fixture native " + stage + " Win32 " + error); }
        private bool injectUnavailable, interrupt;
        private bool testExclusion;
        private bool checkedExclusion;
        partial void TestTransactionUnavailable(ref bool unavailable) { unavailable = injectUnavailable; }
        partial void TestBeforeCommit() { if (interrupt) throw Refusal("fixture-interruption"); }
        partial void TestLocked()
        {
            if (!testExclusion) return;
            // Genuine independent nontransacted opens while this transaction is locked.
            string alias = Path.Combine(target, "foreign-hard-link");
            bool hard = CreateHardLinkW(alias, AssetPath, IntPtr.Zero);
            int hardCode = Marshal.GetLastWin32Error();
            using (var stream = CreateFileW(AssetPath + ":extra", Write, 7, IntPtr.Zero, 2, 0, IntPtr.Zero))
            {
                int streamCode = Marshal.GetLastWin32Error();
                if (hard || !stream.IsInvalid || !IsSharingConflict(hardCode) || !IsSharingConflict(streamCode))
                    throw new Exception("Concurrent link/stream exclusion not demonstrated: " + hardCode + "/" + streamCode);
            }
            using (var outsider=CreateFileW(AssetPath,Write,7,IntPtr.Zero,3,0,IntPtr.Zero))
            {
                int error=Marshal.GetLastWin32Error();
                Expect(outsider.IsInvalid && IsSharingConflict(error),"independent unnamed writer excluded");
            }
            RequiresHold(()=>Directory.Move(target, target+".renamed"));
            checkedExclusion = true;
        }
        private static bool IsSharingConflict(int c) { return c == 32 || c == 6800 || c == 5 || c == 303; }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
        private static extern bool CreateHardLinkW(string path, string existing, IntPtr security);
        private static void Expect(bool value, string message) { if (!value) throw new Exception("Fixture: " + message); }
        private static void RequiresHold(Action fn)
        {
            bool held=false;
            try { fn(); } catch (InvalidOperationException) { held=true; } catch (IOException) { held=true; }
            Expect(held, "required refusal missing");
        }
        private static int serial;
        private static string Work(string root) {
            string dir=Path.Combine(root, "fixture-"+System.Threading.Interlocked.Increment(ref serial)); Directory.CreateDirectory(dir); return dir;
        }
        private static Rc2Witness Seed(string root)
        {
            return new Rc2Witness(root, Hash(FixturePrior), Hash(FixtureAsset), FixtureAsset.Length);
        }
        private static void NsisWrite(string path, byte[] bytes)
        {
            // NSIS 3.13 EW_EXTRACTFILE + myOpenFile: GENERIC_WRITE, CREATE_ALWAYS,
            // FILE_SHARE_READ, followed by SetFileTime on the same owned write handle.
            using (var handle=CreateFileW(path,Write,ShareRead,IntPtr.Zero,2,0,IntPtr.Zero))
            {
                Valid(handle,"fixture-nsis-create-always");
                RandomAccess.Write(handle,bytes,0);
                long time=DateTime.UtcNow.ToFileTimeUtc();
                Expect(SetFileTime(handle,IntPtr.Zero,IntPtr.Zero,ref time),"NSIS SetFileTime");
            }
        }
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool SetFileTime(SafeFileHandle h,IntPtr created,IntPtr accessed,ref long written);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetHandleInformation(SafeFileHandle handle,out int flags);
        public static void TestReparse(string scratch, string alias, string foreign, Action<string,string> junction)
        {
            RequiresHold(()=>Seed(alias));
            string root=Work(scratch);
            using(var w=Seed(root))
            {
                NsisWrite(w.AssetPath,FixtureAsset);NsisWrite(w.MainPath,FixturePrior);w.ConfirmPrior();w.VerifyConfirmedPrior();NsisWrite(w.MainPath,FixtureCurrent);
                string moved=w.AssetPath+".owned";
                File.Move(w.AssetPath,moved);
                junction(w.AssetPath,foreign);
                try
                {
                    RequiresHold(()=>w.Commit(Hash(FixtureCurrent)));
                    Expect((File.GetAttributes(w.AssetPath) & FileAttributes.ReparsePoint)!=0,"leaf reparse preserved");
                    Expect(File.ReadAllBytes(moved).AsSpan().SequenceEqual(FixtureAsset),"witnessed other name preserved");
                    Expect(File.ReadAllBytes(Path.Combine(foreign,"sentinel")).AsSpan().SequenceEqual(FixturePrior),"foreign referent preserved");
                }
                finally {Directory.Delete(w.AssetPath,false);}
            }
        }
        private static void RecordSecurity(string path, bool dir, string sddl)
        {
            if(dir)
            {
                var acl=new System.Security.AccessControl.DirectorySecurity();
                acl.SetSecurityDescriptorSddlForm(sddl,System.Security.AccessControl.AccessControlSections.Access | System.Security.AccessControl.AccessControlSections.Owner);
                FileSystemAclExtensions.SetAccessControl(new DirectoryInfo(path),acl);
            }
            else
            {
                var acl=new System.Security.AccessControl.FileSecurity();
                acl.SetSecurityDescriptorSddlForm(sddl,System.Security.AccessControl.AccessControlSections.Access | System.Security.AccessControl.AccessControlSections.Owner);
                FileSystemAclExtensions.SetAccessControl(new System.IO.FileInfo(path),acl);
            }
        }
        public static void TestStartupRecords(string scratch)
        {
            string root=Work(scratch), name="startup-generation.initialized", manifest="startup-generations.json",
                terminal="startup-generation-c7a017fe-cfe0-44a1-9195-f0983817cccb-terminal.json";
            string home=Path.Combine(root,".agent-forge-startup-v1");
            string sid;
            using(var owner=System.Security.Principal.WindowsIdentity.GetCurrent()){sid=owner.User.Value;}
            string sdDir="O:"+sid+"D:P(A;OICI;FA;;;"+sid+")(A;OICI;FA;;;SY)";
            string sdFile="O:"+sid+"D:P(A;;FA;;;"+sid+")(A;;FA;;;SY)";
            Expect(ReadStartupRecordAt(root,name,true)==null,"absent fixed journal");
            RequiresHold(()=>ReadStartupRecordAt(root,manifest,true));
            RequiresHold(()=>ReadStartupRecordAt(root,terminal,true));
            RequiresHold(()=>ReadStartupRecordAt(root,"../"+name,false));
            RequiresHold(()=>ReadStartupRecordAt(root,terminal.ToUpperInvariant(),false));
            RequiresHold(()=>ReadStartupRecordAt(root,terminal.Replace("-44a1-","-14a1-"),false));
            Directory.CreateDirectory(home);RecordSecurity(home,true,sdDir);
            RequiresHold(()=>ReadStartupRecordAt(root,name,true));
            var data=Encoding.UTF8.GetBytes("owned startup fixture");
            foreach(var leaf in new[]{name,manifest,terminal})
            {
                string path=Path.Combine(home,leaf);File.WriteAllBytes(path,data);
                RequiresHold(()=>ReadStartupRecordAt(root,leaf,false)); // inherited file ACL
                RecordSecurity(path,false,sdFile);
                Expect(ReadStartupRecordAt(root,leaf,false).AsSpan().SequenceEqual(data),"private record");
            }
            string marker=Path.Combine(home,name);
            File.WriteAllBytes(marker,new byte[65]);RequiresHold(()=>ReadStartupRecordAt(root,name,false));
            File.WriteAllBytes(marker,data);File.WriteAllBytes(marker+":extra",FixtureAsset);
            RequiresHold(()=>ReadStartupRecordAt(root,name,false));File.Delete(marker+":extra");
            string other=Path.Combine(root,"record-alias");Expect(CreateHardLinkW(other,marker,IntPtr.Zero),"read-record link");
            RequiresHold(()=>ReadStartupRecordAt(root,name,false));File.Delete(other);
            RecordSecurity(marker,false,"O:"+sid+"D:P(A;;FA;;;"+sid+")(A;;FR;;;WD)");RequiresHold(()=>ReadStartupRecordAt(root,name,false));
            RecordSecurity(marker,false,sdFile);
            RecordSecurity(home,true,"O:"+sid+"D:P(A;OICI;FA;;;"+sid+")(A;OICI;FR;;;WD)");RequiresHold(()=>ReadStartupRecordAt(root,name,true));
            RecordSecurity(home,true,sdDir);
            Expect(ReadStartupRecordAt(root,name,true).AsSpan().SequenceEqual(data),"fresh-position complete record");
        }

        public static string RunScratch(string scratch)
        {
            if (Directory.GetFileSystemEntries(scratch).Length != 0) throw new Exception("Scratch must be empty.");
            int tests=0;
            foreach (string mode in new[] {"known","unconfirmed","prior-security","preflight-change","preflight-replaced-main","skip-preflight","changed-security","changed-attributes","changed-time","same-bytes-changed-time","wrong-prior","wrong-current","same-version","nonhex","replacement","modified","hardlink","stream","writer","cutoff","unavailable","concurrent","dispose"})
            {
                string root=Work(scratch);
                using (var w=Seed(root))
                {
                    NsisWrite(w.AssetPath,FixtureAsset);NsisWrite(w.MainPath,FixturePrior);
                    if(mode=="unconfirmed") { RequiresHold(()=>w.Commit(Hash(FixtureCurrent))); Expect(File.Exists(w.AssetPath),"unconfirmed preserved");tests++;continue; }
                    if(mode=="wrong-prior") { NsisWrite(w.MainPath,FixtureCurrent); RequiresHold(w.ConfirmPrior);Expect(File.Exists(w.AssetPath),"wrong prior preserved");tests++;continue; }
                    string owner;
                    using(var identity=System.Security.Principal.WindowsIdentity.GetCurrent()){owner=identity.User.Value;}
                    string changedAcl="O:"+owner+"D:P(A;;FA;;;"+owner+")(A;;FR;;;WD)";
                    if(mode=="prior-security") {
                        RecordSecurity(w.AssetPath,false,changedAcl);RequiresHold(w.ConfirmPrior);
                        Expect(File.ReadAllBytes(w.AssetPath).AsSpan().SequenceEqual(FixtureAsset),"prior ACL held");tests++;continue;
                    }
                    w.ConfirmPrior();
                    if(mode=="preflight-change" || mode=="preflight-replaced-main") {
                        if(mode=="preflight-change") RecordSecurity(w.AssetPath,false,changedAcl);
                        else { File.Move(w.MainPath,w.MainPath+".witnessed");NsisWrite(w.MainPath,FixturePrior); }
                        RequiresHold(w.VerifyConfirmedPrior);RequiresHold(w.VerifyConfirmedPrior);
                        Expect(File.ReadAllBytes(w.AssetPath).AsSpan().SequenceEqual(FixtureAsset),"refused prior still present");
                        tests++;continue;
                    }
                    if(mode=="skip-preflight") {
                        NsisWrite(w.MainPath,FixtureCurrent);RequiresHold(()=>w.Commit(Hash(FixtureCurrent)));
                        Expect(File.ReadAllBytes(w.AssetPath).AsSpan().SequenceEqual(FixtureAsset),"no commit without successful preflight");
                        tests++;continue;
                    }
                    w.VerifyConfirmedPrior();
                    using(var exclusive = CreateFileW(w.MainPath,Read|Write,0,IntPtr.Zero,3,0,IntPtr.Zero))
                        Valid(exclusive,"fixture-prior-main-exclusive-after-preflight");
                    RequiresHold(w.VerifyConfirmedPrior);
                    NsisWrite(w.MainPath,FixtureCurrent);
                    var oldTime=File.GetLastWriteTimeUtc(w.AssetPath);
                    var changedTime=oldTime.AddMinutes(-3);
                    string expected=Hash(FixtureCurrent), backup=w.AssetPath+".moved";
                    switch(mode) {
                        case "changed-security": RecordSecurity(w.AssetPath,false,changedAcl); break;
                        case "changed-attributes": File.SetAttributes(w.AssetPath,File.GetAttributes(w.AssetPath) ^ FileAttributes.NotContentIndexed); break;
                        case "changed-time": File.SetLastWriteTimeUtc(w.AssetPath,changedTime);break;
                        case "same-bytes-changed-time":
                            NsisWrite(w.AssetPath,FixtureAsset);File.SetLastWriteTimeUtc(w.AssetPath,changedTime);break;
                        case "wrong-current": expected=Hash(FixtureAsset); break;
                        case "same-version": expected=Hash(FixturePrior); break;
                        case "nonhex": expected=new string('z',64); break;
                        case "replacement": File.Move(w.AssetPath,backup); NsisWrite(w.AssetPath,FixtureAsset); break;
                        case "modified": NsisWrite(w.AssetPath,Encoding.UTF8.GetBytes("one edited payload")); break;
                        case "hardlink": Expect(CreateHardLinkW(backup,w.AssetPath,IntPtr.Zero),"setup hardlink"); break;
                        case "stream": File.WriteAllBytes(w.AssetPath+":private",FixturePrior); break;
                        case "cutoff": w.interrupt=true; break;
                        case "unavailable": w.injectUnavailable=true; break;
                        case "concurrent": w.testExclusion=true; break;
                        case "dispose": w.Dispose(); break;
                    }
                    if(mode=="known" || mode=="concurrent"){
                        w.Commit(expected);
                        Expect(!File.Exists(w.AssetPath),"owned resource absent");
                        Expect(!w.testExclusion || w.checkedExclusion,"hook proved conflicts");
                        RequiresHold(()=>w.Commit(expected));
                    } else {
                        if(mode=="writer") {
                            using(var external=CreateFileW(w.AssetPath,Write,7,IntPtr.Zero,3,0,IntPtr.Zero)) {
                                Valid(external,"fixture-writer"); RequiresHold(()=>w.Commit(expected));
                            }
                        } else RequiresHold(()=>w.Commit(expected));
                        byte[] wanted=mode=="modified"?Encoding.UTF8.GetBytes("one edited payload"):FixtureAsset;
                        Expect(File.ReadAllBytes(w.AssetPath).AsSpan().SequenceEqual(wanted),mode+" preserved");
                        if(mode=="replacement" || mode=="hardlink")Expect(File.ReadAllBytes(backup).AsSpan().SequenceEqual(FixtureAsset),"other name preserved");
                        if(mode=="changed-time" || mode=="same-bytes-changed-time")
                            Expect(File.GetLastWriteTimeUtc(w.AssetPath)==changedTime, "timestamp preserved");
                        if(mode=="changed-attributes")
                            Expect((uint)File.GetAttributes(w.AssetPath)!=w.confirmedAsset.attributes,"changed flags preserved");
                        if(mode=="changed-security") {
                            using(var f=OpenChecked(w.AssetPath,Read,ShareRead,false))
                                Expect(!ReadSecurity(f,7).AsSpan().SequenceEqual(w.originalSecurity),"changed security retained");
                        }
                        if(mode=="stream")Expect(File.ReadAllBytes(w.AssetPath+":private").AsSpan().SequenceEqual(FixturePrior),"private stream preserved");
                    }
                }
                tests++;
            }
            string existing=Work(scratch),target=Path.Combine(existing,"Agent Forge Harness");
            Directory.CreateDirectory(target);var marker=Path.Combine(target,"existing");
            File.WriteAllBytes(marker,FixtureAsset);RequiresHold(()=>Seed(existing));Expect(File.Exists(marker),"existing root preserved");tests++;
            string parentTest=Work(scratch);
            using(var w=Seed(parentTest))
            {
                int flags; Expect(GetHandleInformation(w.witness,out flags) && (flags & 1)==0,"witness noninheritable");
                foreach(var parent in w.parents)Expect(GetHandleInformation(parent,out flags) && (flags & 1)==0,"ancestor noninheritable");
                RequiresHold(()=>Directory.Move(w.target,w.target+".moved"));
            }
            Directory.Move(Path.Combine(parentTest,"Agent Forge Harness"),Path.Combine(parentTest,"released"));
            tests++;
            var exe=Path.Combine(Work(scratch),"selected.exe");File.WriteAllBytes(exe,FixtureCurrent);
            using (PinSetup(exe,Hash(FixtureCurrent))) {
                RequiresHold(()=>File.WriteAllBytes(exe,FixturePrior));RequiresHold(()=>File.Move(exe,exe+".replaced"));
            }
            RequiresHold(()=>PinSetup(exe,Hash(FixturePrior)));
            RequiresHold(()=>PinSetup(Path.Combine(Path.GetDirectoryName(exe),".","selected.exe"),Hash(FixtureCurrent)));
            tests++;
            Directory.Move(target,target+"-released");Expect(File.Exists(Path.Combine(target+"-released","existing")),"only fixture parent moved");
            return "Passed "+tests+" native RC2 ownership fixtures.";
        }
    }
}
'@
Add-Type -TypeDefinition ($sourceText+[Environment]::NewLine+$testSource) -ErrorAction Stop
$scratch=[IO.Directory]::CreateTempSubdirectory('forge-witness-fixture-').FullName
try{
 [AgentForge.Upgrade.Rc2Witness]::RunScratch($scratch)
 [AgentForge.Upgrade.Rc2Witness]::TestStartupRecords($scratch)
 'Passed fixed startup record names, bounds, identity, ACL and absence controls.'
 $foreign=[IO.Directory]::CreateDirectory((Join-Path $scratch 'jtarget')).FullName
 [IO.File]::WriteAllText((Join-Path $foreign 'sentinel'),'known predecessor fixture',[Text.UTF8Encoding]::new($false))
 $alias=Join-Path $scratch 'jparent'
 $junction=[Action[string,string]]{param($path,$destination) $null=New-Item -ItemType Junction -Path $path -Target $destination -ErrorAction Stop}
 $junction.Invoke($alias,$foreign)
 try{[AgentForge.Upgrade.Rc2Witness]::TestReparse($scratch,$alias,$foreign,$junction)}
 finally{[IO.Directory]::Delete($alias,$false)}
 'Passed two additional real NTFS ancestor and leaf reparse controls.'
}
finally{
 $expectedParent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
 $owned=[IO.Path]::GetFullPath($scratch)
 if([IO.Path]::GetDirectoryName($owned) -cne $expectedParent -or [IO.Path]::GetFileName($owned) -cnotmatch '^forge-witness-fixture-[A-Za-z0-9.]+$'){throw 'Unexpected scratch location.'}
 Remove-Item -LiteralPath $owned -Recurse -Force
}
