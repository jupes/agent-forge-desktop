// Windows package ownership proof for the corrected RC2 dashboard resource.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace AgentForge.Upgrade
{
    public sealed partial class Rc2Witness : IDisposable
    {
        private const string Asset = "index-iTXU0aPJ.js";
        private const string OfficialPrior = "241e66375dbe9ed783c5a206abd43b71299816587874b404f3f6f9da4d4dcc54";
        private const string OfficialAsset = "47c6463edea52394dc6c4c156082d5c6b6f89616f25bcf9788244337fd030fe2";
        private const long OfficialBytes = 1686538;
        private const uint Read = 0x80000000, Write = 0x40000000, DeleteAccess = 0x10000;
        private const uint ShareRead = 1, ShareWrite = 2, ShareDelete = 4;
        private const uint NoFollow = 0x00200000, Backup = 0x02000000, DeleteOnClose = 0x04000000;
        private const uint UnsupportedAttributes = 0x40 | 0x200 | 0x400 | 0x800 | 0x1000 | 0x4000 | 0x40000 | 0x400000;
        private readonly List<SafeFileHandle> parents = new List<SafeFileHandle>();
        private readonly string target, assetHash, priorMain;
        private readonly long assetBytes;
        private SafeFileHandle witness, priorMainWitness;
        private FileInfo confirmedMain;
        private FileInfo original, confirmedAsset;
        private readonly byte[] originalSecurity;
        private enum Phase { Seeded, Confirmed, ReadyForUpgrade, Spent }
        private Phase phase;

        public static Rc2Witness Begin()
        {
            var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData,
                Environment.SpecialFolderOption.DoNotVerify);
            return new Rc2Witness(local, OfficialPrior, OfficialAsset, OfficialBytes);
        }

        // Setup executable attestation is read-only. Keep the exact leaf and every ancestor
        // held through the orchestrator's direct launch and complete process settlement.
        public static IDisposable PinSetup(string absolutePath, string expectedSha256)
        {
            if (!OperatingSystem.IsWindows() || absolutePath == null || !Path.IsPathFullyQualified(absolutePath) ||
                absolutePath.StartsWith(@"\\", StringComparison.Ordinal) || absolutePath.Length > 240 ||
                !String.Equals(Path.GetFullPath(absolutePath), absolutePath, StringComparison.Ordinal) ||
                !String.Equals(Path.GetExtension(absolutePath), ".exe", StringComparison.OrdinalIgnoreCase) ||
                !DigestForm(expectedSha256))
                throw Refusal("setup-selection");
            foreach (string part in absolutePath.Substring(Path.GetPathRoot(absolutePath).Length).Split(Path.DirectorySeparatorChar))
                if (part.Length == 0 || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal) ||
                    part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw Refusal("setup-path");
            var volume = new DriveInfo(Path.GetPathRoot(absolutePath));
            if (volume.DriveType != DriveType.Fixed || !String.Equals(volume.DriveFormat, "NTFS", StringComparison.OrdinalIgnoreCase))
                throw Refusal("setup-volume");
            var held = new HeldFiles();
            try
            {
                PinChain(Path.GetDirectoryName(absolutePath), held.Files);
                var file = OpenChecked(absolutePath, Read, ShareRead, false);
                held.Files.Add(file);
                VerifyDigest(file, expectedSha256, null);
                return held;
            }
            catch { held.Dispose(); throw; }
        }
        // The state directory, record grammar, limits and owner-private policy mirror
        // startup_coordination_windows.rs and private_files::read. Never accept a path.
        public static byte[] ReadStartupRecord(string name)
        {
            return ReadStartupRecord(name, false);
        }
        public static byte[] ReadStartupRecord(string name, bool allowAbsentDirectory)
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData,
                Environment.SpecialFolderOption.DoNotVerify);
            return ReadStartupRecordAt(local, name, allowAbsentDirectory);
        }
        private static byte[] ReadStartupRecordAt(string local, string name, bool allowAbsentDirectory)
        {
            int limit;
            if (name == "startup-generation.initialized") limit = 64;
            else if (!allowAbsentDirectory && name == "startup-generations.json") limit = 131072;
            else if (!allowAbsentDirectory && name != null && name.Length == 69 &&
                System.Text.RegularExpressions.Regex.IsMatch(name,
                    @"\Astartup-generation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-terminal\.json\z"))
                limit = 8192;
            else throw Refusal("record-name");
            if (!OperatingSystem.IsWindows() || !Path.IsPathFullyQualified(local) || local.StartsWith(@"\\") ||
                local.Length + name.Length + 26 > 240) throw Refusal("record-root");
            var drive = new DriveInfo(Path.GetPathRoot(local));
            if (drive.DriveType != DriveType.Fixed || !String.Equals(drive.DriveFormat, "NTFS", StringComparison.OrdinalIgnoreCase))
                throw Refusal("record-volume");
            using (var pins = new HeldFiles())
            {
                PinChain(local, pins.Files);
                string dir = Path.Combine(local, ".agent-forge-startup-v1");
                var directory = CreateFileW(dir, Read, ShareRead | ShareWrite, IntPtr.Zero, 3, NoFollow | Backup, IntPtr.Zero);
                int error = Marshal.GetLastWin32Error();
                pins.Files.Add(directory);
                if (directory.IsInvalid && allowAbsentDirectory && error == 2) return null;
                Inspect(directory, true); PrivateSecurity(directory, true);
                using (var file = OpenChecked(Path.Combine(dir, name), Read, ShareRead, false))
                {
                    PrivateSecurity(file, false);
                    long length = Length(Inspect(file, false));
                    if (length <= 0 || length > limit) throw Refusal("record-size");
                    SingleStream(file, length);
                    var bytes = new byte[checked((int)length)]; int used = 0;
                    while (used < bytes.Length)
                    {
                        int count = RandomAccess.Read(file, bytes.AsSpan(used), used);
                        if (count == 0) throw Refusal("record-read");
                        used += count;
                    }
                    PrivateSecurity(file, false); PrivateSecurity(directory, true);
                    SingleStream(file, length);
                    return bytes;
                }
            }
        }
        private static void PrivateSecurity(SafeFileHandle h, bool directory)
        {
            byte[] security = ReadSecurity(h, 5);
            var descriptor = new System.Security.AccessControl.RawSecurityDescriptor(security, 0);
            var acl = descriptor.DiscretionaryAcl;
            using (var impersonated = System.Security.Principal.WindowsIdentity.GetCurrent(true))
            using (var processUser = System.Security.Principal.WindowsIdentity.GetCurrent())
            {
                var sid = processUser.User;
                if (impersonated != null || sid == null || descriptor.Owner == null || !descriptor.Owner.Equals(sid) ||
                    (descriptor.ControlFlags & System.Security.AccessControl.ControlFlags.DiscretionaryAclProtected) == 0 ||
                    acl == null || acl.Count < 1 || acl.Count > 8) throw Refusal("record-security");
                bool fullUser = false;
                for (int i = 0; i < acl.Count; ++i)
                {
                    var ace = acl[i] as System.Security.AccessControl.CommonAce;
                    if (ace == null || ace.AceType != System.Security.AccessControl.AceType.AccessAllowed ||
                        (int)ace.AceFlags != (directory ? 3 : 0) ||
                        ace.BinaryLength != 8 + ace.SecurityIdentifier.BinaryLength) throw Refusal("record-security");
                    bool user = ace.SecurityIdentifier.Equals(sid);
                    if (!user && !ace.SecurityIdentifier.IsWellKnown(System.Security.Principal.WellKnownSidType.LocalSystemSid))
                        throw Refusal("record-security");
                    if (user && (ace.AccessMask & 0x001f01ff) == 0x001f01ff) fullUser = true;
                }
                if (!fullUser) throw Refusal("record-security");
            }
        }
        // GetKernelObjectSecurity returns a self-relative descriptor. Capture the exact
        // requested owner, group and DACL, including flags and ACE ordering, from the handle.
        private static byte[] ReadSecurity(SafeFileHandle handle, uint fields)
        {
            uint needed;
            if (GetKernelObjectSecurity(handle, fields, null, 0, out needed) ||
                Marshal.GetLastWin32Error() != 122 || needed < 20 || needed > 65536)
                throw Refusal("file-security");
            byte[] security = new byte[needed];
            if (!GetKernelObjectSecurity(handle, fields, security, needed, out needed) || needed != security.Length)
                throw Refusal("file-security");
            return security;
        }
        [DllImport("advapi32.dll", SetLastError=true)]
        private static extern bool GetKernelObjectSecurity(SafeFileHandle handle, uint fields, [Out] byte[] bytes,
            uint n, out uint needed);


        private sealed class HeldFiles : IDisposable
        {
            internal readonly List<SafeFileHandle> Files = new List<SafeFileHandle>();
            public void Dispose()
            {
                for (int i = Files.Count - 1; i >= 0; --i) Files[i].Dispose();
                Files.Clear();
            }
        }
        private static bool DigestForm(string value)
        {
            return value != null && value.Length == 64 &&
                !Array.Exists(value.ToCharArray(), c => !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f'));
        }

        private Rc2Witness(string local, string prior, string digest, long length)
        {
            if (!OperatingSystem.IsWindows() || !Path.IsPathFullyQualified(local) ||
                local.StartsWith(@"\\", StringComparison.Ordinal) || local.Length > 185)
                throw Refusal("local-root");
            string volume = Path.GetPathRoot(local);
            var drive = new DriveInfo(volume);
            if (drive.DriveType != DriveType.Fixed || !String.Equals(drive.DriveFormat, "NTFS", StringComparison.OrdinalIgnoreCase))
                throw Refusal("local-ntfs");
            target = Path.Combine(local, "Agent Forge Harness");
            priorMain = prior; assetHash = digest; assetBytes = length;
            try
            {
                PinChain(local, parents);
                foreach (string component in new[] { "Agent Forge Harness", "dashboard", "assets" })
                {
                    // Atomic directory creation returns the pinned object. Never adopt an existing
                    // target, even one which happens to be empty at this moment.
                    parents.Add(CreateRelative(parents[parents.Count - 1], component, true));
                }
                witness = CreateRelative(parents[parents.Count - 1], Asset, false);
                original = Inspect(witness, false);
                originalSecurity = ReadSecurity(witness, 7);
                if (Length(original) != 0) throw Refusal("seed-size");
                // A freshly created object can retain a nontransactional writer's file state
                // through its creating handle. Overlap it with an independent read-only open;
                // compare their identities while both are still alive.
                var continuity = OpenChecked(AssetPath, Read, ShareRead | ShareWrite | ShareDelete, false);
                var observed = Inspect(continuity, false);
                if (observed.volume != original.volume || observed.indexHigh != original.indexHigh ||
                    observed.indexLow != original.indexLow) { continuity.Dispose(); throw Refusal("seed-identity"); }
                witness.Dispose(); witness = continuity;
            }
            catch { Dispose(); throw; }
        }

        public void ConfirmPrior()
        {
            lock (parents)
            {
                RequirePhase(Phase.Seeded);
                phase = Phase.Spent;
                using (var main = OpenChecked(MainPath, Read, ShareRead, false))
                using (var leaf = OpenChecked(AssetPath, Read, ShareRead | ShareDelete, false))
                {
                    VerifyDigest(main, priorMain, null);
                    confirmedAsset = VerifyAsset(leaf, false);
                    confirmedMain = Inspect(main, false);
                    // Pin the prior main's identity through revalidation. NSIS can still
                    // overwrite the ordinary stream or replace the file during upgrade.
                    priorMainWitness = OpenChecked(MainPath, Read, ShareRead | ShareWrite | ShareDelete, false);
                    if (!SameIdentity(Inspect(priorMainWitness, false), confirmedMain)) throw Refusal("prior-main-identity");
                }
                phase = Phase.Confirmed;
            }
        }

        // Run under the launcher's package guard immediately before starting the successor.
        // Revalidate the initial baseline, then release executable handles before Restart Manager.
        public void VerifyConfirmedPrior()
        {
            lock (parents)
            {
                RequirePhase(Phase.Confirmed);
                using (var main = OpenChecked(MainPath, Read, ShareRead, false))
                using (var leaf = OpenChecked(AssetPath, Read, ShareRead | ShareDelete, false))
                {
                    var info = Inspect(main, false);
                    if (!SameIdentity(info, confirmedMain) || !SameMetadata(info, confirmedMain))
                        throw Refusal("prior-main-changed");
                    VerifyDigest(main, priorMain, null);
                    VerifyAsset(leaf, true);
                }
                // The asset stays witnessed across the upgrade. An ordinary open on the
                // executable would interfere with NSIS's Restart Manager preflight.
                priorMainWitness.Dispose();
                priorMainWitness = null;
                phase = Phase.ReadyForUpgrade;
            }
        }
        private static bool SameIdentity(FileInfo a, FileInfo b)
        {
            return a.volume == b.volume && a.indexHigh == b.indexHigh && a.indexLow == b.indexLow;
        }
        private static bool SameMetadata(FileInfo a, FileInfo b)
        {
            return a.attributes == b.attributes && a.writeHigh == b.writeHigh && a.writeLow == b.writeLow;
        }
        public void Commit(string expectedSuccessorMainSha256)
        {
            lock (parents)
            {
                RequirePhase(Phase.ReadyForUpgrade);
                phase = Phase.Spent;
                if (!DigestForm(expectedSuccessorMainSha256) || expectedSuccessorMainSha256 == priorMain)
                    throw Refusal("successor-digest");
                using (var main = OpenChecked(MainPath, Read, ShareRead, false))
                {
                    VerifyDigest(main, expectedSuccessorMainSha256, null);
                    using (var tx = StartTransaction())
                    {
                        bool confirmed = false;
                        try
                        {
                            // The writer locks every stream in this file against outside modification.
                            // Delete-on-close applies to this transacted handle. No pathname is unlinked.
                            using (var leaf = CreateFileTransactedW(AssetPath, Read | Write | DeleteAccess,
                                ShareRead, IntPtr.Zero, 3, NoFollow | DeleteOnClose, IntPtr.Zero,
                                tx, IntPtr.Zero, IntPtr.Zero))
                            {
                                Valid(leaf, "transaction-open");
                                VerifyAsset(leaf, true);
                                TestLocked();
                                VerifyAsset(leaf, true);
                                // Original handle prevents identity reuse through both validations.
                                witness.Dispose();
                            }
                            TestBeforeCommit();
                            if (!CommitTransaction(tx)) throw Refusal("commit-unconfirmed");
                            confirmed = true;
                        }
                        finally { if (!confirmed) RollbackTransaction(tx); }
                    }
                    // Report success only on positively observed absence under the retained parent pins.
                    using (var remainder = CreateFileW(AssetPath, Read, ShareRead | ShareWrite | ShareDelete,
                        IntPtr.Zero, 3, NoFollow, IntPtr.Zero))
                    {
                        if (!remainder.IsInvalid || Marshal.GetLastWin32Error() != 2)
                            throw Refusal("removal-unconfirmed");
                    }
                }
            }
        }

        static partial void TestNativeCode(string stage, int error);
        partial void TestLocked();
        partial void TestBeforeCommit();
        partial void TestTransactionUnavailable(ref bool unavailable);
        private SafeFileHandle StartTransaction()
        {
            bool unavailable = false;
            TestTransactionUnavailable(ref unavailable);
            if (unavailable) throw Refusal("transaction-unavailable");
            var tx = CreateTransaction(IntPtr.Zero, IntPtr.Zero, 0, 0, 0, 5000, IntPtr.Zero);
            Valid(tx, "transaction-unavailable");
            return tx;
        }
        private string MainPath { get { return Path.Combine(target, "agent-forge-desktop.exe"); } }
        private string AssetPath { get { return Path.Combine(target, "dashboard", "assets", Asset); } }

        private FileInfo VerifyAsset(SafeFileHandle file, bool afterPrior)
        {
            FileInfo info = Inspect(file, false);
            if (info.volume != original.volume || info.indexHigh != original.indexHigh ||
                info.indexLow != original.indexLow || Length(info) != assetBytes)
                throw Refusal("asset-identity");
            if (!ReadSecurity(file, 7).AsSpan().SequenceEqual(originalSecurity)) throw Refusal("asset-security");
            // RC2 sets the packaged attributes and last-write time when extracting into
            // the seeded file. Later reads may update access time, which is not compared.
            if (afterPrior && !SameMetadata(info, confirmedAsset))
                throw Refusal("asset-metadata");
            SingleStream(file, assetBytes);
            VerifyDigest(file, assetHash, assetBytes);
            return info;
        }
        private static void VerifyDigest(SafeFileHandle file, string expected, long? exact)
        {
            long length = Length(Inspect(file, false));
            if (length < 1 || length > 512L * 1024 * 1024 || exact.HasValue && length != exact.Value)
                throw Refusal("file-size");
            using (var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
            {
                byte[] buffer = new byte[65536]; long offset = 0;
                while (offset < length)
                {
                    int n = RandomAccess.Read(file, buffer.AsSpan(0, (int)Math.Min(buffer.Length, length - offset)), offset);
                    if (n == 0) throw Refusal("short-read");
                    hash.AppendData(buffer, 0, n); offset += n;
                }
                if (Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant() != expected)
                    throw Refusal("file-digest");
            }
        }
        private static void SingleStream(SafeFileHandle file, long expectedBytes)
        {
            // FILE_STREAM_INFO: NextEntryOffset, StreamNameLength, StreamSize, AllocationSize,
            // then the UTF-16 stream name. The single permitted row always fits in this buffer.
            byte[] row = new byte[128];
            if (!GetFileInformationByHandleEx(file, 7, row, (uint)row.Length) ||
                BitConverter.ToUInt32(row, 0) != 0 || BitConverter.ToUInt32(row, 4) != 14 ||
                BitConverter.ToInt64(row, 8) != expectedBytes ||
                Encoding.Unicode.GetString(row, 24, 14) != "::$DATA")
                throw Refusal("streams");
        }
        private void RequirePhase(Phase next)
        {
            if (phase != next || witness == null || witness.IsClosed) throw Refusal("witness-state");
        }
        private static void PinChain(string local, List<SafeFileHandle> held)
        {
            var path = new DirectoryInfo(local);
            var chain = new Stack<string>();
            while (path != null) { chain.Push(path.FullName); path = path.Parent; }
            foreach (var dir in chain) held.Add(OpenChecked(dir, Read, ShareRead | ShareWrite, true));
        }
        private static SafeFileHandle OpenChecked(string path, uint access, uint share, bool directory)
        {
            var h = CreateFileW(path, access, share, IntPtr.Zero, 3, NoFollow | (directory ? Backup : 0), IntPtr.Zero);
            try { Inspect(h, directory); return h; } catch { h.Dispose(); throw; }
        }

        // NT relative CREATE is necessary here: CreateDirectory followed by a pathname open
        // would let an unrelated directory occupy the name before we acquire its handle.
        private static SafeFileHandle CreateRelative(SafeFileHandle parent, string component, bool directory)
        {
            IntPtr text = Marshal.StringToHGlobalUni(component);
            IntPtr name = IntPtr.Zero;
            try
            {
                var value = new NativeName { length = checked((ushort)(component.Length * 2)),
                    capacity = checked((ushort)((component.Length + 1) * 2)), buffer = text };
                name = Marshal.AllocHGlobal(Marshal.SizeOf<NativeName>());
                Marshal.StructureToPtr(value, name, false);
                var obj = new ObjectAttributes { length = Marshal.SizeOf<ObjectAttributes>(),
                    root = parent.DangerousGetHandle(), name = name, attributes = 0x40 };
                SafeFileHandle h;
                IoStatus io;
                uint options = NoFollow | 0x20u | (directory ? 1u : 0x40u);
                // FILE_SYNCHRONOUS_IO_NONALERT needs SYNCHRONIZE. Genuine NSIS 3.13 File
                // requests GENERIC_WRITE with FILE_SHARE_READ: the witness must own no write/delete
                // access and permit write. Sharing DELETE lets same-byte replacement be detected.
                int status = NtCreateFile(out h, Read | 0x100000u, ref obj, out io, IntPtr.Zero,
                    0, ShareRead | ShareWrite | (directory ? 0 : ShareDelete), 2, options, IntPtr.Zero, 0);
                GC.KeepAlive(parent);
                if (status < 0 || io.information.ToInt64() != 2)
                {
                    if (h != null) h.Dispose();
                    throw Refusal("owned-create");
                }
                try { Inspect(h, directory); return h; } catch { h.Dispose(); throw; }
            }
            finally
            {
                if (name != IntPtr.Zero) Marshal.FreeHGlobal(name);
                Marshal.FreeHGlobal(text);
            }
        }
        private static long Length(FileInfo i) { return (long)i.sizeHigh << 32 | i.sizeLow; }
        private static FileInfo Inspect(SafeFileHandle file, bool directory)
        {
            Valid(file, "file-open");
            FileInfo i;
            if (!GetFileInformationByHandle(file, out i) || (i.attributes & UnsupportedAttributes) != 0 ||
                ((i.attributes & 0x10) != 0) != directory || !directory && i.links != 1 ||
                (i.indexHigh == 0 && i.indexLow == 0)) throw Refusal("file-kind");
            return i;
        }
        private static void Valid(SafeFileHandle h, string stage)
        {
            if (h == null || h.IsInvalid) { TestNativeCode(stage, Marshal.GetLastWin32Error()); throw Refusal(stage); }
        }
        private static InvalidOperationException Refusal(string stage)
        {
            return new InvalidOperationException("RC2 witness held: " + stage + ".");
        }
        public void Dispose()
        {
            lock (parents)
            {
                phase = Phase.Spent;
                if (witness != null) witness.Dispose();
                if (priorMainWitness != null) priorMainWitness.Dispose();
                for (int i = parents.Count - 1; i >= 0; --i) parents[i].Dispose();
                parents.Clear();
            }
        }

        [StructLayout(LayoutKind.Sequential)] private struct FileInfo
        {
            internal uint attributes, createLow, createHigh, accessLow, accessHigh, writeLow, writeHigh;
            internal uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
        }
        [StructLayout(LayoutKind.Sequential)] private struct NativeName { internal ushort length, capacity; internal IntPtr buffer; }
        [StructLayout(LayoutKind.Sequential)] private struct ObjectAttributes
        { internal int length; internal IntPtr root, name; internal uint attributes; internal IntPtr security, quality; }
        [StructLayout(LayoutKind.Sequential)] private struct IoStatus { internal IntPtr status, information; }

        [DllImport("ntdll.dll")] private static extern int NtCreateFile(out SafeFileHandle file, uint access,
            ref ObjectAttributes attributes, out IoStatus status, IntPtr allocationSize, uint fileAttributes,
            uint share, uint disposition, uint options, IntPtr ea, uint eaLength);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security,
            uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
        private static extern SafeFileHandle CreateFileTransactedW(string path, uint access, uint share,
            IntPtr security, uint disposition, uint flags, IntPtr template, SafeFileHandle tx, IntPtr mini, IntPtr extra);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int cls, [Out] byte[] info, uint bytes);
        [DllImport("ktmw32.dll", SetLastError=true)] private static extern SafeFileHandle CreateTransaction(IntPtr security, IntPtr unit, uint options, uint isolation, uint flags, uint timeout, IntPtr description);
        [DllImport("ktmw32.dll", SetLastError=true)] private static extern bool CommitTransaction(SafeFileHandle transaction);
        [DllImport("ktmw32.dll", SetLastError=true)] private static extern bool RollbackTransaction(SafeFileHandle transaction);
    }
}
