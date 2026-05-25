using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Yamlet.App.Models;
using Yamlet.App.Services;

namespace Yamlet.App.ViewModels;

public sealed partial class RunnerItemViewModel : ViewModelBase
{
    public RunnerItemViewModel(int index, RequestNodeViewModel requestNode)
    {
        Index = index;
        RequestNode = requestNode;
        Name = requestNode.Name;
        Method = requestNode.MethodLabel;
        Url = requestNode.Request.Url;
    }

    public int Index { get; }
    public RequestNodeViewModel RequestNode { get; }
    public string Name { get; }
    public string Method { get; }
    public string Url { get; }

    [ObservableProperty]
    private bool _isSelected = true;

    [ObservableProperty]
    private string _status = "Ready";

    [ObservableProperty]
    private string _duration = "-";

    [ObservableProperty]
    private string _result = "-";

    public bool Passed => Status == "Passed";
    public bool Failed => Status == "Failed";

    partial void OnStatusChanged(string value)
    {
        OnPropertyChanged(nameof(Passed));
        OnPropertyChanged(nameof(Failed));
    }
}

public sealed partial class RunnerViewModel : ViewModelBase
{
    private readonly RequestExecutor _executor;
    private readonly Func<RequestNodeViewModel, VariableContext> _contextFactory;
    private readonly Func<RequestNodeViewModel, RequestScriptVariables> _scriptVariablesFactory;
    private readonly Func<RequestNodeViewModel, YamletAuth?> _collectionAuthFactory;
    private readonly Func<string?> _environmentName;
    private readonly Action<string>? _status;

    public RunnerViewModel(
        string title,
        IEnumerable<RequestNodeViewModel> requests,
        RequestExecutor executor,
        Func<RequestNodeViewModel, VariableContext> contextFactory,
        Func<RequestNodeViewModel, RequestScriptVariables> scriptVariablesFactory,
        Func<RequestNodeViewModel, YamletAuth?> collectionAuthFactory,
        Func<string?> environmentName,
        Action<string>? status = null)
    {
        Title = title;
        _executor = executor;
        _contextFactory = contextFactory;
        _scriptVariablesFactory = scriptVariablesFactory;
        _collectionAuthFactory = collectionAuthFactory;
        _environmentName = environmentName;
        _status = status;

        var index = 1;
        foreach (var request in requests)
        {
            Items.Add(new RunnerItemViewModel(index++, request));
        }

        RefreshCounts();
    }

    public string Title { get; }
    public ObservableCollection<RunnerItemViewModel> Items { get; } = new();

    [ObservableProperty]
    private bool _isRunning;

    [ObservableProperty]
    private string _summary = "Ready to run.";

    [ObservableProperty]
    private int _selectedCount;

    [ObservableProperty]
    private int _passedCount;

    [ObservableProperty]
    private int _failedCount;

    [ObservableProperty]
    private string _duration = "-";

    public string EnvironmentText => _environmentName() ?? "No environment";

    [RelayCommand]
    private void SelectAll()
    {
        foreach (var item in Items)
        {
            item.IsSelected = true;
        }
        RefreshCounts();
    }

    [RelayCommand]
    private void DeselectAll()
    {
        foreach (var item in Items)
        {
            item.IsSelected = false;
        }
        RefreshCounts();
    }

    [RelayCommand]
    private void Reset()
    {
        foreach (var item in Items)
        {
            item.Status = "Ready";
            item.Duration = "-";
            item.Result = "-";
        }
        Summary = "Ready to run.";
        Duration = "-";
        PassedCount = 0;
        FailedCount = 0;
        RefreshCounts();
    }

    [RelayCommand]
    private async Task StartAsync()
    {
        if (IsRunning)
        {
            return;
        }

        var selected = Items.Where(static item => item.IsSelected).ToList();
        if (selected.Count == 0)
        {
            Summary = "Select at least one request.";
            return;
        }

        IsRunning = true;
        PassedCount = 0;
        FailedCount = 0;
        Summary = $"Running {selected.Count} request(s)...";
        _status?.Invoke(Summary);
        var started = DateTimeOffset.Now;

        foreach (var item in selected)
        {
            item.Status = "Running";
            item.Duration = "-";
            item.Result = "-";
        }

        foreach (var item in selected)
        {
            await RunItemAsync(item);
        }

        Duration = FormatDuration(DateTimeOffset.Now - started);
        Summary = $"Run complete: {PassedCount} passed, {FailedCount} failed.";
        _status?.Invoke($"{Title}: {Summary}");
        IsRunning = false;
    }

    private async Task RunItemAsync(RunnerItemViewModel item)
    {
        var request = item.RequestNode.Request;
        var response = await _executor.ExecuteAsync(
            request,
            _contextFactory(item.RequestNode),
            _collectionAuthFactory(item.RequestNode),
            _scriptVariablesFactory(item.RequestNode));

        item.Duration = $"{response.DurationMs} ms";
        if (response is { IsError: false, StatusCode: >= 200 and < 400 })
        {
            item.Status = "Passed";
            item.Result = $"{response.StatusCode} {response.ReasonPhrase}".Trim();
            PassedCount++;
        }
        else
        {
            item.Status = "Failed";
            item.Result = response.IsError
                ? response.ErrorMessage ?? "Request failed"
                : $"{response.StatusCode} {response.ReasonPhrase}".Trim();
            FailedCount++;
        }
    }

    private void RefreshCounts()
    {
        SelectedCount = Items.Count(static item => item.IsSelected);
        OnPropertyChanged(nameof(EnvironmentText));
    }

    private static string FormatDuration(TimeSpan duration) =>
        duration.TotalSeconds >= 1
            ? $"{duration.TotalSeconds:0.0} s"
            : $"{duration.TotalMilliseconds:0} ms";
}
