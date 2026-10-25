using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace GdreNative
{
    /// <summary>
    /// Windows-only process-tree ownership helper. The PowerShell wrapper passes a
    /// typed launch request decoded from its private stdin pipe; this helper creates
    /// the root with PROC_THREAD_ATTRIBUTE_JOB_LIST so Job membership exists at
    /// creation, before the root runs. A background reader treats the next control
    /// byte or EOF on that pipe as a cooperative stop request.
    ///
    /// Status protocol (one atomically replaced JSON document):
    /// - state: starting, monitoring, cleaning, completed, stopped, cancelled, or failed.
    /// - launch.started/launch.rootPid describe the root this helper actually created.
    /// - attach.success is retained as the ownership-established signal.
    /// - root.exitObserved and root.exitCode describe the root wait result; exitCode
    ///   is an unsigned Win32 value and is null until observation.
    /// - cleanup.state is not-started, pending, confirmed, or failed. A null
    ///   activeJobPids value means enumeration failed; it is never an empty tree.
    /// - knownPids is the union of observed Job members and the root. PIDs are
    ///   numeric only; the Job handle is the ownership authority.
    /// - failure is a bounded explanation for the first terminal helper failure.
    ///
    /// The helper never writes process diagnostics to stdout/stderr and never
    /// persists the launch arguments. Closing the Job handle (including an OS close
    /// when this helper is terminated) applies the kill-on-job-close limit.
    /// </summary>
    public static class GdreJobObjectRunner
    {
        private const uint GenericRead = 0x80000000;
        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint OpenExisting = 3;
        private const uint DuplicateSameAccess = 0x00000002;
        private const int StandardInputHandle = -10;
        private const int StandardOutputHandle = -11;
        private const int StandardErrorHandle = -12;

        private const int JobObjectBasicProcessIdList = 3;
        private const int JobObjectExtendedLimitInformationClass = 9;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;

        private const uint WaitObject0 = 0x00000000;
        private const uint WaitTimeout = 0x00000102;
        private const uint WaitFailed = 0xffffffff;

        private const uint CreateUnicodeEnvironment = 0x00000400;
        private const uint ExtendedStartupInfoPresent = 0x00080000;
        private const uint CreateNoWindow = 0x08000000;
        private const uint StartfUseStdHandles = 0x00000100;

        private const int ErrorBadLength = 24;
        private const int ErrorInsufficientBuffer = 122;
        private const int ErrorMoreData = 234;

        private const uint MoveFileReplaceExisting = 0x00000001;
        private const uint MoveFileWriteThrough = 0x00000008;

        // PROC_THREAD_ATTRIBUTE_JOB_LIST and PROC_THREAD_ATTRIBUTE_HANDLE_LIST.
        private static readonly IntPtr ProcThreadAttributeJobList = new IntPtr(0x0002000D);
        private static readonly IntPtr ProcThreadAttributeHandleList = new IntPtr(0x00020002);

        private sealed class StatusModel
        {
            public int RootPid;
            public string State = "starting";
            public string EventName = "starting";
            public bool LaunchStarted;
            public bool CancelledBeforeLaunch;
            public string RootStartedAtUtc;
            public bool RootAssigned;
            public bool AttachSuccess;
            public string AttachError;
            public bool StopRequested;
            public string StopReason;
            public bool RootExitObserved;
            public bool RootExitCodeKnown;
            public uint RootExitCode;
            public string RootExitAtUtc;
            public bool RootElapsedKnown;
            public double RootElapsedMilliseconds;
            public string CleanupState = "not-started";
            public bool CleanupConfirmed;
            public string CleanupError;
            public bool JobHandleClosed;
            public string Failure;
            public List<uint> KnownPids = new List<uint>();
            public List<uint> ActiveJobPids;
            public string UpdatedAtUtc;

            public StatusModel(int rootPid)
            {
                RootPid = rootPid;
                UpdatedAtUtc = DateTime.UtcNow.ToString("o");
            }
        }

        private sealed class StopSignal
        {
            public int Requested;
            public string Reason;
            public SafeKernelHandle Job;
        }

        private sealed class StatusWriter
        {
            private readonly string _path;
            private readonly string _directory;
            private readonly UTF8Encoding _utf8 = new UTF8Encoding(false);

            public StatusWriter(string path)
            {
                if (String.IsNullOrWhiteSpace(path))
                {
                    throw new ArgumentException("Status path is required.");
                }

                _path = Path.GetFullPath(path);
                _directory = Path.GetDirectoryName(_path);
                if (String.IsNullOrEmpty(_directory))
                {
                    throw new ArgumentException("Status path must include a directory.");
                }

                Directory.CreateDirectory(_directory);
            }

            public bool TryWrite(StatusModel status, out string error)
            {
                error = null;
                string tempPath = _path + ".tmp-" + Guid.NewGuid().ToString("N");
                try
                {
                    status.UpdatedAtUtc = DateTime.UtcNow.ToString("o");
                    string json = ToJson(status);
                    byte[] bytes = _utf8.GetBytes(json);
                    using (FileStream stream = new FileStream(tempPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
                    {
                        stream.Write(bytes, 0, bytes.Length);
                        stream.Flush(true);
                    }

                    uint moveError = 0;
                    bool moved = false;
                    for (int attempt = 0; attempt < 20; attempt++)
                    {
                        if (NativeMethods.MoveFileEx(tempPath, _path, MoveFileReplaceExisting | MoveFileWriteThrough))
                        {
                            moved = true;
                            break;
                        }
                        moveError = (uint)Marshal.GetLastWin32Error();
                        // A transient scanner/reader handle can block replacement
                        // (sharing or lock violation); retry briefly before failing.
                        if (moveError != 32 && moveError != 33 && moveError != 5)
                        {
                            break;
                        }
                        Thread.Sleep(10);
                    }
                    if (!moved)
                    {
                        error = "MoveFileEx(status) failed with Win32 " + moveError;
                        TryDelete(tempPath);
                        return false;
                    }

                    return true;
                }
                catch (Exception exception)
                {
                    error = Limit("Status write failed: " + exception.Message);
                    TryDelete(tempPath);
                    return false;
                }
            }

            private static void TryDelete(string path)
            {
                try
                {
                    if (File.Exists(path))
                    {
                        File.Delete(path);
                    }
                }
                catch
                {
                    // The original status-write error is the useful evidence.
                }
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes
        {
            public int Length;
            public IntPtr SecurityDescriptor;
            public int InheritHandle;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct StartupInfo
        {
            public int Size;
            public IntPtr Reserved;
            public IntPtr Desktop;
            public IntPtr Title;
            public uint X;
            public uint Y;
            public uint XSize;
            public uint YSize;
            public uint XCountChars;
            public uint YCountChars;
            public uint FillAttribute;
            public uint Flags;
            public ushort ShowWindow;
            public ushort Reserved2Size;
            public IntPtr Reserved2;
            public IntPtr StandardInput;
            public IntPtr StandardOutput;
            public IntPtr StandardError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct StartupInfoEx
        {
            public StartupInfo StartupInfo;
            public IntPtr AttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr Process;
            public IntPtr Thread;
            public uint ProcessId;
            public uint ThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        private sealed class NativeMethods
        {
            [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
            public static extern SafeKernelHandle CreateJobObject(IntPtr jobAttributes, string name);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool SetInformationJobObject(
                SafeKernelHandle job,
                int informationClass,
                ref JobObjectExtendedLimitInformation information,
                uint length);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool TerminateJobObject(SafeKernelHandle job, uint exitCode);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool QueryInformationJobObject(
                SafeKernelHandle job,
                int informationClass,
                IntPtr information,
                uint length,
                out uint returnLength);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool IsProcessInJob(SafeKernelHandle process, SafeKernelHandle job, [MarshalAs(UnmanagedType.Bool)] out bool result);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern uint WaitForSingleObject(SafeKernelHandle handle, uint milliseconds);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool GetExitCodeProcess(SafeKernelHandle process, out uint exitCode);

            [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool CreateProcessW(
                string applicationName,
                StringBuilder commandLine,
                IntPtr processAttributes,
                IntPtr threadAttributes,
                [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
                uint creationFlags,
                IntPtr environment,
                string currentDirectory,
                ref StartupInfoEx startupInfo,
                out ProcessInformation processInformation);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool InitializeProcThreadAttributeList(
                IntPtr attributeList,
                int attributeCount,
                int flags,
                ref IntPtr size);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool UpdateProcThreadAttribute(
                IntPtr attributeList,
                uint flags,
                IntPtr attribute,
                IntPtr value,
                IntPtr size,
                IntPtr previousValue,
                IntPtr returnSize);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern IntPtr GetStdHandle(int standardHandle);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern IntPtr GetCurrentProcess();

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool DuplicateHandle(
                IntPtr sourceProcess,
                IntPtr sourceHandle,
                IntPtr targetProcess,
                out IntPtr targetHandle,
                uint desiredAccess,
                [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
                uint options);

            [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
            public static extern SafeKernelHandle CreateFileW(
                string fileName,
                uint desiredAccess,
                uint shareMode,
                ref SecurityAttributes securityAttributes,
                uint creationDisposition,
                uint flagsAndAttributes,
                IntPtr templateFile);

            [DllImport("kernel32.dll", SetLastError = true)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool CloseHandle(IntPtr handle);

            [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
            [return: MarshalAs(UnmanagedType.Bool)]
            public static extern bool MoveFileEx(string existingFileName, string newFileName, uint flags);
        }

        private sealed class SafeKernelHandle : SafeHandleZeroOrMinusOneIsInvalid
        {
            public SafeKernelHandle() : base(true)
            {
            }

            public SafeKernelHandle(IntPtr handle) : base(true)
            {
                SetHandle(handle);
            }

            protected override bool ReleaseHandle()
            {
                return NativeMethods.CloseHandle(handle);
            }
        }

        /// <summary>
        /// Runs until the root exits, a stop/EOF arrives, or ownership fails. The
        /// return value is zero only when observation and cleanup are confirmed and
        /// the status snapshots were persisted. No output goes to process streams.
        /// </summary>
        public static int Run(
            string executable,
            string[] argv,
            string currentDirectory,
            IDictionary<string, string> environment,
            string statusPath,
            int pollMilliseconds,
            Stream control)
        {
            return RunCore(executable, argv, currentDirectory, environment, statusPath, pollMilliseconds, control);
        }

        private static int RunCore(
            string executable,
            string[] argv,
            string currentDirectory,
            IDictionary<string, string> environment,
            string statusPath,
            int pollMilliseconds,
            Stream control)
        {
            StatusModel status = new StatusModel(0);
            StopSignal stop = new StopSignal();
            StatusWriter writer = null;
            SafeKernelHandle job = null;
            SafeKernelHandle root = null;
            bool statusWriteFailed = false;

            try
            {
                ValidateArguments(executable, pollMilliseconds);
                writer = new StatusWriter(statusPath);
                if (!Publish(writer, status, out statusWriteFailed))
                {
                    return 2;
                }

                if (control != null)
                {
                    StartControlReader(control, stop);
                }

                string error;
                job = CreateConfiguredJob(out error);
                if (job == null)
                {
                    Fail(status, "create-job-failed", error, true, error);
                    Publish(writer, status, out statusWriteFailed);
                    return statusWriteFailed ? 2 : 1;
                }
                Volatile.Write(ref stop.Job, job);
                if (Volatile.Read(ref stop.Requested) != 0)
                {
                    // The reader may have observed EOF before the Job existed.
                    NativeMethods.TerminateJobObject(job, 1);
                }

                // No root exists yet. A stop observed before creation must not
                // produce a late launch; only the check below gates creation.
                if (Volatile.Read(ref stop.Requested) != 0)
                {
                    MarkCancelledBeforeLaunch(status, stop);
                    Publish(writer, status, out statusWriteFailed);
                    return statusWriteFailed ? 2 : 0;
                }

                uint rootPid;
                DateTime rootStartedAtUtc;
                Stopwatch lifetime;
                if (!CreateOwnedProcess(job, executable, argv, currentDirectory, environment, out root, out rootPid, out rootStartedAtUtc, out lifetime, out error))
                {
                    // No root exists, so there is nothing to clean up and the
                    // status must not claim a cleanup confirmation.
                    Fail(status, "create-process-failed", error, false, error);
                    Publish(writer, status, out statusWriteFailed);
                    return statusWriteFailed ? 2 : 1;
                }

                status.RootPid = checked((int)rootPid);
                status.RootStartedAtUtc = rootStartedAtUtc.ToString("o");
                status.LaunchStarted = true;
                status.RootAssigned = true;
                status.AttachSuccess = true;
                status.State = "monitoring";
                status.EventName = "launched";
                RefreshKnownPids(job, status, (uint)status.RootPid);
                Publish(writer, status, out statusWriteFailed);

                if (!TryVerifyJobMembership(job, root, out error))
                {
                    Fail(status, "ownership-verification-failed", "Created root is not verified in the owning Job: " + error, true, error);
                    Publish(writer, status, out statusWriteFailed);
                    bool ignoredConfirmed;
                    bool ignoredPublishFailure;
                    TryCleanup(job, status, writer, out ignoredConfirmed, out ignoredPublishFailure);
                    return statusWriteFailed ? 2 : 1;
                }

                while (true)
                {
                    if (Volatile.Read(ref stop.Requested) != 0)
                    {
                        return RunStopPath(job, root, status, writer, stop, lifetime, ref statusWriteFailed);
                    }

                    uint waitResult = NativeMethods.WaitForSingleObject(root, (uint)pollMilliseconds);
                    if (waitResult == WaitTimeout)
                    {
                        RefreshKnownPids(job, status, (uint)status.RootPid);
                        status.EventName = "monitoring";
                        Publish(writer, status, out statusWriteFailed);
                        continue;
                    }

                    if (waitResult == WaitObject0)
                    {
                        // A stop that raced with natural exit wins the truthful
                        // classification: it is reported as a stop.
                        if (Volatile.Read(ref stop.Requested) != 0)
                        {
                            return RunStopPath(job, root, status, writer, stop, lifetime, ref statusWriteFailed);
                        }

                        ObserveRootExit(root, status, lifetime, out error);
                        if (error != null)
                        {
                            status.Failure = Limit("Root exit was signaled but its exit code could not be observed: " + error);
                        }
                        status.EventName = "root-exit-observed";
                        Publish(writer, status, out statusWriteFailed);

                        ReleaseRoot(ref root);
                        bool confirmed;
                        bool cleanupPublishFailed;
                        TryCleanup(job, status, writer, out confirmed, out cleanupPublishFailed);
                        status.State = confirmed ? "completed" : "failed";
                        status.EventName = confirmed ? "cleanup-confirmed" : "cleanup-failed";
                        if (!confirmed && String.IsNullOrEmpty(status.Failure))
                        {
                            status.Failure = "Natural root exit cleanup was not confirmed.";
                        }
                        if (confirmed)
                        {
                            status.Failure = null;
                        }
                        Publish(writer, status, out statusWriteFailed);
                        return confirmed && !cleanupPublishFailed && !statusWriteFailed ? 0 : 1;
                    }

                    error = waitResult == WaitFailed
                        ? DescribeError("WaitForSingleObject(root)")
                        : "WaitForSingleObject(root) returned an unexpected result (" + waitResult + ").";
                    Fail(status, "monitor-failed", error, false, error);
                    bool ignoredNatural;
                    bool ignoredWrite;
                    TryCleanup(job, status, writer, out ignoredNatural, out ignoredWrite);
                    return statusWriteFailed ? 2 : 1;
                }
            }
            catch (Exception exception)
            {
                string message = Limit("Helper exception: " + exception.Message);
                Fail(status, "helper-failed", message, status.LaunchStarted, message);
                if (writer != null)
                {
                    Publish(writer, status, out statusWriteFailed);
                }
                return statusWriteFailed ? 2 : 1;
            }
            finally
            {
                ReleaseRoot(ref root);
                if (job != null)
                {
                    // SafeHandle closes the Job even if this process is terminated
                    // by the OS; the kernel then enforces kill-on-job-close.
                    job.Dispose();
                    status.JobHandleClosed = true;
                    if (writer != null && status.CleanupConfirmed)
                    {
                        Publish(writer, status, out statusWriteFailed);
                    }
                }
            }
        }

        private static int RunStopPath(
            SafeKernelHandle job,
            SafeKernelHandle root,
            StatusModel status,
            StatusWriter writer,
            StopSignal stop,
            Stopwatch lifetime,
            ref bool statusWriteFailed)
        {
            status.StopRequested = true;
            status.StopReason = Volatile.Read(ref stop.Reason);
            status.State = "stopping";
            status.EventName = "stop-requested";
            Publish(writer, status, out statusWriteFailed);

            // Terminate the Job independently of status publication. This also
            // covers a control reader that observed the stop before owning work.
            NativeMethods.TerminateJobObject(job, 1);
            uint waitResult = NativeMethods.WaitForSingleObject(root, 5000);
            if (waitResult == WaitObject0)
            {
                string observeError;
                ObserveRootExit(root, status, lifetime, out observeError);
                if (observeError != null)
                {
                    status.Failure = Limit("Stop requested; root exit code was unreadable: " + observeError);
                }
            }
            else
            {
                status.Failure = Limit("Stop requested; root exit was not observed within 5000 ms.");
            }

            ReleaseRoot(ref root);
            bool confirmed;
            bool cleanupPublishFailed;
            TryCleanup(job, status, writer, out confirmed, out cleanupPublishFailed);
            status.State = confirmed ? "stopped" : "failed";
            status.EventName = confirmed ? "stop-cleanup-confirmed" : "stop-cleanup-failed";
            status.Failure = confirmed
                ? Limit("A stop was requested; the owned process tree was terminated.")
                : status.Failure ?? Limit("Stop cleanup was not confirmed.");
            Publish(writer, status, out statusWriteFailed);
            return confirmed && !cleanupPublishFailed && !statusWriteFailed ? 0 : 1;
        }

        private static void MarkCancelledBeforeLaunch(StatusModel status, StopSignal stop)
        {
            status.State = "cancelled";
            status.EventName = "cancelled-before-launch";
            status.CancelledBeforeLaunch = true;
            status.StopRequested = true;
            status.StopReason = Volatile.Read(ref stop.Reason);
            status.Failure = Limit("Cancellation was requested before the root process was created.");
        }

        private static void StartControlReader(Stream control, StopSignal stop)
        {
            Thread reader = new Thread(() =>
            {
                string reason = "control";
                try
                {
                    int value = control.ReadByte();
                    if (value < 0)
                    {
                        reason = "eof";
                    }
                }
                catch
                {
                    reason = "control-error";
                }

                Volatile.Write(ref stop.Reason, reason);
                Interlocked.Exchange(ref stop.Requested, 1);
                SafeKernelHandle job = Volatile.Read(ref stop.Job);
                if (job != null)
                {
                    try
                    {
                        // Prompt termination so the main wait does not need to
                        // poll for the whole interval before acting on the stop.
                        NativeMethods.TerminateJobObject(job, 1);
                    }
                    catch
                    {
                        // The main loop also observes the stop request.
                    }
                }
            });
            reader.IsBackground = true;
            reader.Name = "gdre-control-reader";
            reader.Start();
        }

        private static SafeKernelHandle CreateConfiguredJob(out string error)
        {
            error = null;
            SafeKernelHandle job = NativeMethods.CreateJobObject(IntPtr.Zero, null);
            if (job == null || job.IsInvalid)
            {
                if (job != null)
                {
                    job.Dispose();
                }
                error = DescribeError("CreateJobObject");
                return null;
            }

            JobObjectExtendedLimitInformation limits = new JobObjectExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            if (!NativeMethods.SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformationClass,
                ref limits,
                (uint)Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation))))
            {
                error = DescribeError("SetInformationJobObject(kill-on-job-close)");
                job.Dispose();
                return null;
            }

            // No breakaway limit is granted: owned descendants stay in this Job.
            return job;
        }

        private static bool CreateOwnedProcess(
            SafeKernelHandle job,
            string executable,
            string[] argv,
            string currentDirectory,
            IDictionary<string, string> environment,
            out SafeKernelHandle process,
            out uint processId,
            out DateTime startedAtUtc,
            out Stopwatch lifetime,
            out string error)
        {
            process = null;
            processId = 0;
            startedAtUtc = DateTime.MinValue;
            lifetime = null;
            error = null;
            SafeKernelHandle nul = null;
            SafeKernelHandle standardOutput = null;
            SafeKernelHandle standardError = null;
            GCHandle environmentPin = default(GCHandle);
            IntPtr attributeList = IntPtr.Zero;
            IntPtr jobValue = IntPtr.Zero;
            IntPtr handleArray = IntPtr.Zero;
            bool attributeListInitialized = false;

            try
            {
                SecurityAttributes inheritable = new SecurityAttributes();
                inheritable.Length = Marshal.SizeOf(typeof(SecurityAttributes));
                inheritable.InheritHandle = 1;
                nul = NativeMethods.CreateFileW("NUL", GenericRead, FileShareRead | FileShareWrite, ref inheritable, OpenExisting, 0, IntPtr.Zero);
                if (nul == null || nul.IsInvalid)
                {
                    error = DescribeError("CreateFileW(NUL)");
                    return false;
                }

                if (!TryDuplicateInheritableHandle(StandardOutputHandle, out standardOutput, out error)
                    || !TryDuplicateInheritableHandle(StandardErrorHandle, out standardError, out error))
                {
                    return false;
                }

                byte[] environmentBlock = BuildEnvironmentBlock(environment);
                environmentPin = GCHandle.Alloc(environmentBlock, GCHandleType.Pinned);
                IntPtr environmentPointer = environmentPin.AddrOfPinnedObject();

                IntPtr size = IntPtr.Zero;
                NativeMethods.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                if (size == IntPtr.Zero)
                {
                    error = DescribeError("InitializeProcThreadAttributeList(size)");
                    return false;
                }
                attributeList = Marshal.AllocHGlobal(size);
                if (!NativeMethods.InitializeProcThreadAttributeList(attributeList, 2, 0, ref size))
                {
                    error = DescribeError("InitializeProcThreadAttributeList");
                    return false;
                }
                attributeListInitialized = true;

                jobValue = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobValue, job.DangerousGetHandle());
                if (!NativeMethods.UpdateProcThreadAttribute(
                    attributeList,
                    0,
                    ProcThreadAttributeJobList,
                    jobValue,
                    new IntPtr(IntPtr.Size),
                    IntPtr.Zero,
                    IntPtr.Zero))
                {
                    error = DescribeError("UpdateProcThreadAttribute(job-list)");
                    return false;
                }

                IntPtr[] inherited = new IntPtr[]
                {
                    nul.DangerousGetHandle(),
                    standardOutput.DangerousGetHandle(),
                    standardError.DangerousGetHandle(),
                };
                handleArray = Marshal.AllocHGlobal(IntPtr.Size * inherited.Length);
                for (int index = 0; index < inherited.Length; index++)
                {
                    Marshal.WriteIntPtr(handleArray, index * IntPtr.Size, inherited[index]);
                }
                if (!NativeMethods.UpdateProcThreadAttribute(
                    attributeList,
                    0,
                    ProcThreadAttributeHandleList,
                    handleArray,
                    new IntPtr(IntPtr.Size * inherited.Length),
                    IntPtr.Zero,
                    IntPtr.Zero))
                {
                    error = DescribeError("UpdateProcThreadAttribute(handle-list)");
                    return false;
                }

                StartupInfoEx startup = new StartupInfoEx();
                startup.StartupInfo.Size = Marshal.SizeOf(typeof(StartupInfoEx));
                startup.StartupInfo.Flags = StartfUseStdHandles;
                startup.StartupInfo.StandardInput = nul.DangerousGetHandle();
                startup.StartupInfo.StandardOutput = standardOutput.DangerousGetHandle();
                startup.StartupInfo.StandardError = standardError.DangerousGetHandle();
                startup.AttributeList = attributeList;

                string commandLine = BuildCommandLine(executable, argv);
                uint creationFlags = ExtendedStartupInfoPresent | CreateUnicodeEnvironment | CreateNoWindow;
                ProcessInformation information;
                startedAtUtc = DateTime.UtcNow;
                lifetime = Stopwatch.StartNew();
                if (!NativeMethods.CreateProcessW(
                    executable,
                    new StringBuilder(commandLine),
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    creationFlags,
                    environmentPointer,
                    currentDirectory,
                    ref startup,
                    out information))
                {
                    error = DescribeError("CreateProcessW");
                    return false;
                }

                if (information.Thread != IntPtr.Zero)
                {
                    NativeMethods.CloseHandle(information.Thread);
                }
                process = new SafeKernelHandle(information.Process);
                processId = information.ProcessId;
                return true;
            }
            finally
            {
                if (attributeListInitialized)
                {
                    NativeMethods.DeleteProcThreadAttributeList(attributeList);
                }
                if (attributeList != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(attributeList);
                }
                if (jobValue != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(jobValue);
                }
                if (handleArray != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(handleArray);
                }
                if (environmentPin.IsAllocated)
                {
                    environmentPin.Free();
                }
                if (nul != null)
                {
                    nul.Dispose();
                }
                if (standardOutput != null)
                {
                    standardOutput.Dispose();
                }
                if (standardError != null)
                {
                    standardError.Dispose();
                }
            }
        }

        private static bool TryDuplicateInheritableHandle(int standardHandle, out SafeKernelHandle duplicated, out string error)
        {
            duplicated = null;
            error = null;
            IntPtr source = NativeMethods.GetStdHandle(standardHandle);
            if (source == IntPtr.Zero || source == new IntPtr(-1))
            {
                error = "The helper standard handle " + standardHandle + " is unavailable.";
                return false;
            }

            IntPtr target;
            if (!NativeMethods.DuplicateHandle(
                NativeMethods.GetCurrentProcess(),
                source,
                NativeMethods.GetCurrentProcess(),
                out target,
                0,
                true,
                DuplicateSameAccess))
            {
                error = DescribeError("DuplicateHandle(" + standardHandle + ")");
                return false;
            }

            duplicated = new SafeKernelHandle(target);
            return true;
        }

        private static string BuildCommandLine(string executable, string[] argv)
        {
            StringBuilder commandLine = new StringBuilder();
            AppendArgument(commandLine, executable, true);
            if (argv != null)
            {
                for (int index = 0; index < argv.Length; index++)
                {
                    AppendArgument(commandLine, argv[index], false);
                }
            }
            return commandLine.ToString();
        }

        /// <summary>
        /// Quotes one argument with the CommandLineToArgvW backslash/quote rules so
        /// the child observes the exact typed argument, including empty strings,
        /// spaces, quotes, backslashes, and Unicode.
        /// </summary>
        private static void AppendArgument(StringBuilder commandLine, string argument, bool first)
        {
            if (argument == null)
            {
                argument = String.Empty;
            }
            if (!first)
            {
                commandLine.Append(' ');
            }

            bool needsQuotes = argument.Length == 0;
            if (!needsQuotes)
            {
                for (int index = 0; index < argument.Length; index++)
                {
                    char character = argument[index];
                    if (character == ' ' || character == '\t' || character == '"')
                    {
                        needsQuotes = true;
                        break;
                    }
                }
            }
            if (!needsQuotes)
            {
                commandLine.Append(argument);
                return;
            }

            commandLine.Append('"');
            int backslashes = 0;
            for (int index = 0; index < argument.Length; index++)
            {
                char character = argument[index];
                if (character == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (character == '"')
                {
                    commandLine.Append('\\', (backslashes * 2) + 1);
                    commandLine.Append('"');
                    backslashes = 0;
                    continue;
                }
                if (backslashes > 0)
                {
                    commandLine.Append('\\', backslashes);
                    backslashes = 0;
                }
                commandLine.Append(character);
            }
            if (backslashes > 0)
            {
                commandLine.Append('\\', backslashes * 2);
            }
            commandLine.Append('"');
        }

        private static byte[] BuildEnvironmentBlock(IDictionary<string, string> environment)
        {
            List<string> entries = new List<string>();
            if (environment != null)
            {
                foreach (KeyValuePair<string, string> pair in environment)
                {
                    if (String.IsNullOrEmpty(pair.Key) || pair.Key.IndexOf('=') >= 0 || pair.Value == null)
                    {
                        continue;
                    }
                    entries.Add(pair.Key + "=" + pair.Value);
                }
            }
            entries.Sort(StringComparer.OrdinalIgnoreCase);

            StringBuilder block = new StringBuilder();
            for (int index = 0; index < entries.Count; index++)
            {
                block.Append(entries[index]);
                block.Append('\0');
            }
            if (entries.Count == 0)
            {
                block.Append('\0');
            }
            block.Append('\0');
            return Encoding.Unicode.GetBytes(block.ToString());
        }

        private static bool TryVerifyJobMembership(SafeKernelHandle job, SafeKernelHandle root, out string error)
        {
            error = null;
            bool inJob;
            if (NativeMethods.IsProcessInJob(root, job, out inJob))
            {
                if (!inJob)
                {
                    error = "IsProcessInJob reported that the created root is not in the owning Job.";
                    return false;
                }
                return true;
            }

            int lastError = Marshal.GetLastWin32Error();
            // A root that exited immediately may no longer be queryable. Job
            // membership was established at creation; the monitor still handles
            // the observed exit, so this is not an attach failure.
            if (NativeMethods.WaitForSingleObject(root, 0) == WaitObject0)
            {
                return true;
            }
            error = "IsProcessInJob failed with Win32 " + lastError + ".";
            return false;
        }

        private static void ObserveRootExit(SafeKernelHandle root, StatusModel status, Stopwatch lifetime, out string error)
        {
            error = null;
            status.RootExitObserved = true;
            status.RootExitAtUtc = DateTime.UtcNow.ToString("o");
            if (lifetime != null)
            {
                status.RootElapsedKnown = true;
                status.RootElapsedMilliseconds = lifetime.Elapsed.TotalMilliseconds;
            }
            uint exitCode;
            if (!NativeMethods.GetExitCodeProcess(root, out exitCode))
            {
                error = DescribeError("GetExitCodeProcess");
                return;
            }
            status.RootExitCodeKnown = true;
            status.RootExitCode = exitCode;
        }

        private static void ReleaseRoot(ref SafeKernelHandle root)
        {
            if (root != null)
            {
                // Closing our handle removes the last reference this helper holds
                // to a terminated process, so Job enumeration can become empty.
                root.Dispose();
                root = null;
            }
        }

        private static void RefreshKnownPids(SafeKernelHandle job, StatusModel status, uint rootPid)
        {
            List<uint> members;
            string ignoredError;
            if (!TryQueryJobMembers(job, out members, out ignoredError))
            {
                return;
            }

            if (rootPid > 0 && !members.Contains(rootPid))
            {
                members.Add(rootPid);
            }
            for (int index = 0; index < status.KnownPids.Count; index++)
            {
                uint known = status.KnownPids[index];
                if (!members.Contains(known))
                {
                    members.Add(known);
                }
            }
            members.Sort();
            status.KnownPids = members;
        }

        private static bool TryCleanup(
            SafeKernelHandle job,
            StatusModel status,
            StatusWriter writer,
            out bool confirmed,
            out bool publishFailed)
        {
            confirmed = false;
            publishFailed = false;
            status.State = "cleaning";
            status.CleanupState = "pending";
            status.EventName = "cleanup-started";
            Publish(writer, status, out publishFailed);

            string error;
            List<uint> members;
            if (!TryQueryJobMembers(job, out members, out error))
            {
                return CleanupFailure(status, writer, "Cleanup could not enumerate Job members: " + error, out publishFailed);
            }
            status.ActiveJobPids = members;
            Publish(writer, status, out publishFailed);

            if (members.Count > 0)
            {
                // Terminate the Job independently of status publication. A failed
                // TerminateJobObject is recorded, then the member list decides.
                if (!NativeMethods.TerminateJobObject(job, 1))
                {
                    status.Failure = Limit("TerminateJobObject failed with Win32 " + Marshal.GetLastWin32Error() + ".");
                }
                if (!TryWaitForEmptyJob(job, 5000, out error))
                {
                    if (!NativeMethods.TerminateJobObject(job, 1)
                        || !TryWaitForEmptyJob(job, 5000, out error))
                    {
                        return CleanupFailure(status, writer, "Owned Job members remained after forced cleanup: " + error, out publishFailed);
                    }
                }
            }

            List<uint> remaining;
            if (!TryQueryJobMembers(job, out remaining, out error))
            {
                return CleanupFailure(status, writer, "Cleanup verification could not enumerate Job members: " + error, out publishFailed);
            }
            status.ActiveJobPids = remaining;
            if (remaining.Count != 0)
            {
                return CleanupFailure(status, writer, "Cleanup verification found remaining Job member PIDs.", out publishFailed);
            }

            status.CleanupState = "confirmed";
            status.CleanupConfirmed = true;
            status.CleanupError = null;
            status.EventName = "cleanup-confirmed";
            if (!Publish(writer, status, out publishFailed))
            {
                status.CleanupState = "failed";
                status.CleanupConfirmed = false;
                status.CleanupError = "Status persistence failed while confirming cleanup.";
                if (String.IsNullOrEmpty(status.Failure))
                {
                    status.Failure = status.CleanupError;
                }
                return false;
            }

            confirmed = true;
            return true;
        }

        private static bool CleanupFailure(
            StatusModel status,
            StatusWriter writer,
            string message,
            out bool publishFailed)
        {
            status.State = "failed";
            status.CleanupState = "failed";
            status.CleanupConfirmed = false;
            status.CleanupError = Limit(message);
            status.Failure = status.CleanupError;
            status.EventName = "cleanup-failed";
            Publish(writer, status, out publishFailed);
            return false;
        }

        private static bool TryWaitForEmptyJob(SafeKernelHandle job, int timeoutMilliseconds, out string error)
        {
            error = null;
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);
            while (DateTime.UtcNow < deadline)
            {
                List<uint> members;
                if (!TryQueryJobMembers(job, out members, out error))
                {
                    return false;
                }
                if (members.Count == 0)
                {
                    return true;
                }
                Thread.Sleep(25);
            }
            error = "Timed out waiting for the Job member list to become empty.";
            return false;
        }

        private static bool TryQueryJobMembers(SafeKernelHandle job, out List<uint> members, out string error)
        {
            members = new List<uint>();
            error = null;
            int capacity = 16;
            for (int attempt = 0; attempt < 8; attempt++)
            {
                int size = checked(8 + (capacity * IntPtr.Size));
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    uint returnLength;
                    if (NativeMethods.QueryInformationJobObject(
                        job,
                        JobObjectBasicProcessIdList,
                        buffer,
                        (uint)size,
                        out returnLength))
                    {
                        int assignedCount = Marshal.ReadInt32(buffer, 0);
                        int listedCount = Marshal.ReadInt32(buffer, 4);
                        if (listedCount > capacity)
                        {
                            capacity = listedCount;
                            continue;
                        }
                        if (listedCount < 0 || assignedCount < 0 || listedCount > capacity)
                        {
                            error = "QueryInformationJobObject returned invalid process counts.";
                            return false;
                        }

                        for (int index = 0; index < listedCount; index++)
                        {
                            IntPtr pidPointer = Marshal.ReadIntPtr(buffer, 8 + (index * IntPtr.Size));
                            long pidValue = pidPointer.ToInt64();
                            if (pidValue <= 0 || pidValue > UInt32.MaxValue)
                            {
                                error = "QueryInformationJobObject returned an invalid PID.";
                                return false;
                            }
                            members.Add((uint)pidValue);
                        }
                        return true;
                    }

                    int lastError = Marshal.GetLastWin32Error();
                    if (lastError == ErrorBadLength || lastError == ErrorInsufficientBuffer || lastError == ErrorMoreData || returnLength > (uint)size)
                    {
                        int requested = returnLength > (uint)size ? (int)returnLength : capacity * 2;
                        capacity = Math.Max(capacity * 2, requested / Math.Max(1, IntPtr.Size));
                        continue;
                    }
                    error = "QueryInformationJobObject failed with Win32 " + lastError + ".";
                    return false;
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }

            error = "QueryInformationJobObject exceeded its bounded buffer retries.";
            return false;
        }

        private static void ValidateArguments(string executable, int pollMilliseconds)
        {
            if (String.IsNullOrWhiteSpace(executable))
            {
                throw new ArgumentException("The launch request has no executable.");
            }
            if (pollMilliseconds < 10 || pollMilliseconds > 5000)
            {
                throw new ArgumentException("PollMilliseconds must be between 10 and 5000.");
            }
        }

        private static void Fail(StatusModel status, string eventName, string message, bool attachFailure, string detail)
        {
            status.State = "failed";
            status.EventName = eventName;
            status.Failure = Limit(message);
            if (attachFailure)
            {
                status.AttachSuccess = false;
                status.AttachError = Limit(detail ?? message);
            }
        }

        private static bool Publish(StatusWriter writer, StatusModel status, out bool statusWriteFailed)
        {
            statusWriteFailed = false;
            if (writer == null)
            {
                statusWriteFailed = true;
                return false;
            }
            string error;
            if (!writer.TryWrite(status, out error))
            {
                statusWriteFailed = true;
                status.State = "failed";
                status.EventName = "status-write-failed";
                status.Failure = Limit(error);
                return false;
            }
            return true;
        }

        private static string ToJson(StatusModel status)
        {
            StringBuilder json = new StringBuilder();
            json.Append('{');
            AppendInt(json, "schemaVersion", 2, true);
            AppendString(json, "state", status.State, false);
            AppendString(json, "event", status.EventName, false);
            AppendString(json, "updatedAtUtc", status.UpdatedAtUtc, false);
            AppendInt(json, "rootPid", status.RootPid, false);

            json.Append(",\"launch\":{");
            AppendBool(json, "started", status.LaunchStarted, true);
            AppendInt(json, "rootPid", status.RootPid, false);
            AppendBool(json, "cancelledBeforeLaunch", status.CancelledBeforeLaunch, false);
            AppendNullableString(json, "startedAtUtc", status.RootStartedAtUtc, false);
            json.Append('}');

            json.Append(",\"attach\":{");
            AppendBool(json, "success", status.AttachSuccess, true);
            AppendBool(json, "rootAssigned", status.RootAssigned, false);
            AppendNullableString(json, "error", status.AttachError, false);
            json.Append('}');

            json.Append(",\"stop\":{");
            AppendBool(json, "requested", status.StopRequested, true);
            AppendNullableString(json, "reason", status.StopReason, false);
            json.Append('}');

            json.Append(",\"root\":{");
            AppendInt(json, "pid", status.RootPid, true);
            AppendBool(json, "exitObserved", status.RootExitObserved, false);
            if (status.RootExitCodeKnown)
            {
                AppendUInt(json, "exitCode", status.RootExitCode, false);
            }
            else
            {
                AppendNull(json, "exitCode", false);
            }
            AppendNullableString(json, "observedAtUtc", status.RootExitAtUtc, false);
            if (status.RootElapsedKnown)
            {
                AppendDouble(json, "elapsedMilliseconds", status.RootElapsedMilliseconds, false);
            }
            else
            {
                AppendNull(json, "elapsedMilliseconds", false);
            }
            json.Append('}');

            json.Append(",\"observedExitCode\":");
            if (status.RootExitCodeKnown)
            {
                json.Append(status.RootExitCode.ToString(System.Globalization.CultureInfo.InvariantCulture));
            }
            else
            {
                json.Append("null");
            }

            json.Append(",\"cleanup\":{");
            AppendString(json, "state", status.CleanupState, true);
            AppendBool(json, "confirmed", status.CleanupConfirmed, false);
            AppendPidArrayOrNull(json, "activeJobPids", status.ActiveJobPids, false);
            AppendNullableString(json, "error", status.CleanupError, false);
            AppendBool(json, "jobHandleClosed", status.JobHandleClosed, false);
            json.Append('}');

            AppendPidArray(json, "knownPids", status.KnownPids, false);
            AppendNullableString(json, "failure", status.Failure, false);
            json.Append('}');
            return json.ToString();
        }

        private static void AppendInt(StringBuilder json, string name, int value, bool first)
        {
            AppendName(json, name, first);
            json.Append(value.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        private static void AppendUInt(StringBuilder json, string name, uint value, bool first)
        {
            AppendName(json, name, first);
            json.Append(value.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        private static void AppendDouble(StringBuilder json, string name, double value, bool first)
        {
            AppendName(json, name, first);
            json.Append(value.ToString("R", System.Globalization.CultureInfo.InvariantCulture));
        }

        private static void AppendString(StringBuilder json, string name, string value, bool first)
        {
            AppendName(json, name, first);
            json.Append('"');
            AppendEscaped(json, value ?? "");
            json.Append('"');
        }

        private static void AppendNullableString(StringBuilder json, string name, string value, bool first)
        {
            AppendName(json, name, first);
            if (value == null)
            {
                json.Append("null");
                return;
            }
            json.Append('"');
            AppendEscaped(json, value);
            json.Append('"');
        }

        private static void AppendBool(StringBuilder json, string name, bool value, bool first)
        {
            AppendName(json, name, first);
            json.Append(value ? "true" : "false");
        }

        private static void AppendNull(StringBuilder json, string name, bool first)
        {
            AppendName(json, name, first);
            json.Append("null");
        }

        private static void AppendPidArray(StringBuilder json, string name, List<uint> values, bool first)
        {
            AppendName(json, name, first);
            json.Append('[');
            if (values != null)
            {
                for (int index = 0; index < values.Count; index++)
                {
                    if (index > 0)
                    {
                        json.Append(',');
                    }
                    json.Append(values[index].ToString(System.Globalization.CultureInfo.InvariantCulture));
                }
            }
            json.Append(']');
        }

        private static void AppendPidArrayOrNull(StringBuilder json, string name, List<uint> values, bool first)
        {
            AppendName(json, name, first);
            if (values == null)
            {
                json.Append("null");
                return;
            }
            json.Append('[');
            for (int index = 0; index < values.Count; index++)
            {
                if (index > 0)
                {
                    json.Append(',');
                }
                json.Append(values[index].ToString(System.Globalization.CultureInfo.InvariantCulture));
            }
            json.Append(']');
        }

        private static void AppendName(StringBuilder json, string name, bool first)
        {
            if (!first)
            {
                json.Append(',');
            }
            json.Append('"');
            AppendEscaped(json, name);
            json.Append("\":");
        }

        private static void AppendEscaped(StringBuilder json, string value)
        {
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                switch (character)
                {
                    case '\\': json.Append("\\\\"); break;
                    case '"': json.Append("\\\""); break;
                    case '\b': json.Append("\\b"); break;
                    case '\f': json.Append("\\f"); break;
                    case '\n': json.Append("\\n"); break;
                    case '\r': json.Append("\\r"); break;
                    case '\t': json.Append("\\t"); break;
                    default:
                        if (character < 0x20)
                        {
                            json.Append("\\u");
                            json.Append(((int)character).ToString("x4", System.Globalization.CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            json.Append(character);
                        }
                        break;
                }
            }
        }

        private static string DescribeError(string operation)
        {
            return Limit(operation + " failed with Win32 " + Marshal.GetLastWin32Error() + ".");
        }

        private static string Limit(string value)
        {
            if (String.IsNullOrEmpty(value) || value.Length <= 2048)
            {
                return value;
            }
            return value.Substring(0, 2045) + "...";
        }
    }
}
